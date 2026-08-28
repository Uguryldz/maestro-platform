/**
 * The pilot's LISTENING RULES — which tickets it picks up and how it runs them.
 *
 * The pilot cannot read Postgres (it is DB-free by design), so the rules an
 * admin edits in Studio (the `ListeningRule` table, migration 0011) are mirrored
 * into this in-memory store over the BFF→pilot proxy. The store is the pilot's
 * live source; the DB is the durable one. A restart re-seeds from env-derived
 * defaults, exactly like `SettingsStore`.
 *
 * Two jobs:
 *   1. `discoveryJqlFor` turns the rules into the discovery JQL — instead of the
 *      hard-coded `statusCategory != Done`, it lists exactly the statuses the
 *      rules name (when any `status` rule exists), keeping the bounded-project
 *      guard. `issuetype` rules do not narrow the JQL (Jira filters issue types
 *      awkwardly in JQL and the type is checked per-ticket anyway); they only
 *      classify.
 *   2. `flowTypeFor` classifies a discovered ticket by matching its status or
 *      issue type against the rules, returning the flow to run (or null → the
 *      default, un-classified behaviour).
 */

/** The three flows the pilot can run a ticket through. Mirrors the DB CHECK. */
export type FlowType = "analiz" | "duzeltme" | "gelistirme";

/**
 * Which ticket field a rule matches on. Mirrors the DB CHECK (migration 0020).
 *
 * `assigned` compares no field at all: the rule fires because a human handed
 * the ticket to the bot, which is the trigger the two-member domain could not
 * express. Its `matchValue` is a placeholder the matcher never reads.
 */
export type MatchKind = "status" | "issuetype" | "assigned";

/** One listening rule, as mirrored from the BFF/DB. */
export interface ListeningRule {
  projectKey: string;
  assigneeAccountId: string;
  matchKind: MatchKind;
  matchValue: string;
  flowType: FlowType;
  priority: number;
  enabled: boolean;
  /**
   * Which Studio-defined agent VARIANT runs the analysis for tickets this rule
   * classifies (Faz 3: akış → ajan eşlemesi). Absent (or null in the DB row) =
   * the pilot's default analyst variant, exactly the pre-mapping behaviour. The
   * run resolves the variant's model + persona PER RUN, so publishing a new
   * version takes effect on the next ticket without a restart.
   */
  analystVariantId?: string;
  /** The engineer counterpart of `analystVariantId`. Absent = default variant. */
  engineerVariantId?: string;
}

/** A ticket's fields the classifier looks at. */
export interface ClassifiableTicket {
  /** The ticket's project key (e.g. "OPS"), so a rule only matches its project. */
  projectKey: string;
  status: string | null;
  issueType: string | null;
}

/**
 * The live rule set. Replaced wholesale by `set` (the BFF mirror sends the full
 * list, the same shape Studio shows), read by discovery and classification. A
 * fresh store is empty — no rule means "fall back to the default JQL and run
 * every ticket the old way", so the pilot behaves exactly as before until an
 * admin adds a rule.
 */
export class ListeningRulesStore {
  private rules: readonly ListeningRule[] = [];

  constructor(initial: readonly ListeningRule[] = []) {
    this.set(initial);
  }

  /** Replace the whole rule set (the BFF mirror sends the full list). */
  set(rules: readonly ListeningRule[]): void {
    this.rules = rules
      .filter((r) => r.enabled)
      .map((r) => {
        // Normalise the OPTIONAL agent-variant fields at the boundary: a DB
        // null, an empty string or whitespace all mean "no override" and are
        // stored as ABSENT, so downstream `?? default` fallbacks work uniformly.
        const { analystVariantId, engineerVariantId, ...rest } = r;
        const analyst = normalizeVariantId(analystVariantId);
        const engineer = normalizeVariantId(engineerVariantId);
        return {
          ...rest,
          ...(analyst !== undefined ? { analystVariantId: analyst } : {}),
          ...(engineer !== undefined ? { engineerVariantId: engineer } : {}),
        };
      })
      // Specificity BEFORE priority, mirroring `flow-decision.ts` on the BFF
      // side: a rule that names a condition must be considered before the
      // `assigned` catch-all, or a single "bota atanan her ticket" rule would
      // shadow every deliberate issue-type rule in the project simply by
      // sharing the default priority of 100. `ruleFor` below takes the first
      // match, so this sort is where that precedence actually lives.
      .sort((a, b) => specificityOf(a) - specificityOf(b) || a.priority - b.priority);
  }

  snapshot(): readonly ListeningRule[] {
    return this.rules.map((r) => ({ ...r }));
  }

  /**
   * The discovery JQL for a project + bot account.
   *
   * When the rules name explicit statuses for this project/assignee, the JQL
   * lists exactly those (`status IN (...)`) — the admin has said "these statuses
   * are the trigger". Otherwise it falls back to the caller's default JQL
   * (`statusCategory != Done`), so a pilot with no status rules discovers the
   * same tickets it always did. The project + assignee bound is always kept.
   */
  discoveryJqlFor(botAccountId: string, fallbackJql: string): string {
    const assignee = botAccountId.trim().length > 0 ? `"${botAccountId.trim()}"` : "currentUser()";
    // Status rules for THIS bot, grouped by their own project — no hard-coded
    // project any more, so a rule an admin added on any bound project takes
    // effect. Each project contributes a `(project = X AND status IN (...))`
    // clause; the clauses are OR-ed so one JQL covers every listened project.
    const byProject = new Map<string, Set<string>>();
    for (const r of this.rules) {
      if (r.matchKind !== "status") continue;
      if (r.assigneeAccountId !== "" && r.assigneeAccountId !== botAccountId.trim()) continue;
      const set = byProject.get(r.projectKey) ?? new Set<string>();
      set.add(r.matchValue);
      byProject.set(r.projectKey, set);
    }
    if (byProject.size === 0) return fallbackJql;

    const quote = (s: string): string => `"${s.replace(/"/g, '\\"')}"`;
    const clauses = [...byProject.entries()]
      .map(([project, statuses]) => {
        const inList = [...statuses].map(quote).join(", ");
        return `(project = ${quote(project)} AND status IN (${inList}))`;
      })
      .join(" OR ");
    return `assignee = ${assignee} AND (${clauses}) ORDER BY created DESC`;
  }

  /**
   * The full RULE that classifies a discovered ticket, or null when none does.
   *
   * Rules are already priority-ordered; the first match wins. A `status` rule
   * matches the ticket's current status name; an `issuetype` rule matches its
   * issue-type name. The whole rule (not just its flow type) is returned so the
   * run can also read the rule's agent-variant mapping (`analystVariantId` /
   * `engineerVariantId`) and run the flow with THAT agent. A copy is returned,
   * so a caller can never mutate the live store.
   */
  ruleFor(botAccountId: string, ticket: ClassifiableTicket): ListeningRule | null {
    for (const rule of this.rules) {
      // Match the rule to the ticket's OWN project, not a hard-coded one, so a
      // rule on any bound project classifies its tickets.
      if (rule.projectKey !== ticket.projectKey) continue;
      if (rule.assigneeAccountId !== "" && rule.assigneeAccountId !== botAccountId.trim()) continue;
      // `assigned`: the project + assignee checks above ARE the whole rule, so
      // a ticket that got this far already satisfies it. No field is compared,
      // and `matchValue` is never read.
      if (rule.matchKind === "assigned") return { ...rule };
      const field = rule.matchKind === "status" ? ticket.status : ticket.issueType;
      if (field !== null && field === rule.matchValue) return { ...rule };
    }
    return null;
  }

  /**
   * Classify a discovered ticket into a flow type, or null when no rule matches.
   * Null means "no rule applied" — the caller runs the default flow, so
   * classification never blocks a ticket. (The flow-type projection of
   * `ruleFor`; behaviour unchanged.)
   */
  flowTypeFor(botAccountId: string, ticket: ClassifiableTicket): FlowType | null {
    return this.ruleFor(botAccountId, ticket)?.flowType ?? null;
  }
}

/**
 * Normalise an optional agent-variant id: a DB `null`, empty or all-whitespace
 * value means "no override" (undefined); anything else is the trimmed id.
 */
function normalizeVariantId(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

const FLOW_TYPES: readonly FlowType[] = ["analiz", "duzeltme", "gelistirme"];
const MATCH_KINDS: readonly MatchKind[] = ["status", "issuetype", "assigned"];

/**
 * How specific a rule is — lower is more specific. A rule naming a status or an
 * issue type beats the `assigned` catch-all, which names no condition and is
 * therefore the answer of last resort among the rules that matched.
 */
function specificityOf(rule: ListeningRule): number {
  return rule.matchKind === "assigned" ? 1 : 0;
}

/**
 * Whether an unknown value is a well-formed `ListeningRule`.
 *
 * The pilot mirrors rules from the BFF (validated DB rows), but validates again
 * at the boundary so a malformed entry — an unknown `matchKind`/`flowType`, a
 * missing field — is dropped rather than stored. Classification and JQL
 * derivation then only ever see values they understand.
 */
export function isValidRule(value: unknown): value is ListeningRule {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  // The OPTIONAL agent-variant fields: absent, null (a DB row without an
  // override) or a string are all well-formed — `set` normalises null/empty to
  // "absent". Any other type is a malformed entry and drops the rule.
  const validVariant = (v: unknown): boolean =>
    v === undefined || v === null || typeof v === "string";
  return (
    typeof r["projectKey"] === "string" &&
    typeof r["assigneeAccountId"] === "string" &&
    typeof r["matchValue"] === "string" &&
    typeof r["priority"] === "number" &&
    typeof r["enabled"] === "boolean" &&
    MATCH_KINDS.includes(r["matchKind"] as MatchKind) &&
    FLOW_TYPES.includes(r["flowType"] as FlowType) &&
    validVariant(r["analystVariantId"]) &&
    validVariant(r["engineerVariantId"])
  );
}

/** Human label for a flow type, for logs and the UI. */
export function flowTypeLabel(flow: FlowType): string {
  switch (flow) {
    case "analiz":
      return "analiz";
    case "duzeltme":
      return "düzeltme";
    case "gelistirme":
      return "geliştirme";
  }
}
