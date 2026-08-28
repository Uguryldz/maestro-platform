import type { FlowType, ListeningRuleRecord, MatchKind, StatusMap } from "./listening-store.js";

/**
 * Per-ticket flow selection: which of Maestro's flows a single ticket runs.
 *
 * Until this existed the flow was a DEPLOYMENT-level fact (`MAESTRO_PROFILE` /
 * `MAESTRO_FLOW`, `apps/deploy/src/bin/bff.ts` `flowOf`). One install meant one
 * flow, so a bank running one Jira project could not have "analyse this" and
 * "fix this bug" tickets side by side — the whole deployment had to be one or
 * the other. The rule rows have been able to express the finer answer since the
 * `ListeningRule` table landed; nothing read them on the platform side.
 *
 * Ported from `apps/pilot/src/listening.ts` `ruleFor` (retired pilot, proven on
 * real tickets) rather than reinvented. It lives HERE, in `apps/bff`, because of
 * M44: the decision must be made by the composition-root side that may talk to
 * a database, and `packages/workflows` may not — a workflow that asked Postgres
 * "which flow am I?" would replay differently after any rule edit. The BFF picks
 * the flow BEFORE `signalWithStart` and passes it in the run input, exactly as
 * `openGate` resolves a directory group before handing it to `canCloseGate`
 * (HANDOFF item 2). The rule TYPES also already live in `apps/bff`
 * (`listening-store.ts`), not in the frozen `@maestro/contracts`, so importing
 * them here crosses no frozen boundary.
 */

/** The ticket fields a rule can match on. `null` means "the payload did not say". */
export interface ClassifiableTicket {
  /** The ticket's own project key, so a rule only ever matches its project. */
  projectKey: string;
  status: string | null;
  issueType: string | null;
  /**
   * Who the ticket is assigned to. A rule with a non-empty `assigneeAccountId`
   * only matches when the ticket is assigned to that account — that is how "the
   * Maestro Bot was given this ticket" is expressed. `null` is "unassigned".
   */
  assignee: string | null;
}

/** Why a ticket ended up on the flow it did — the operator-facing answer. */
export type FlowDecisionReason =
  /** A listening rule matched; `ruleId` names it. */
  | "rule"
  /** Rules matched but disagreed; the narrowest flow was taken (fail-closed). */
  | "rule_conflict"
  /** No rule matched, so the deployment default applied. */
  | "default"
  /** No rule matched and the deployment names no default: the full pipeline. */
  | "none";

export interface FlowDecision {
  /** The flow to run, or `null` for "unset — the engine's full-pipeline default". */
  flow: FlowType | null;
  reason: FlowDecisionReason;
  /** The rule that decided, when one did. */
  ruleId?: string;
  /**
   * Every rule that matched, when more than one did. Present only for
   * `rule_conflict`, so the audit entry can name the rules an admin must fix.
   */
  conflictingRuleIds?: readonly string[];
  /**
   * Where the DECIDING rule wants the ticket to sit on the board at each point
   * of the flow. `null` — including for every no-rule outcome — is comment-only
   * mode: Maestro narrates and never moves the ticket, which is what every run
   * did before the map existed.
   *
   * It rides along with the flow rather than being fetched separately for the
   * reason the flow itself is decided here: this is the one moment the rule set
   * is read, and the answer is pinned into the run's start input. A workflow
   * that asked for its map later could get a different one — an admin editing a
   * rule at lunchtime would change where the morning's tickets land, with the
   * run's own history unable to say why.
   *
   * The map belongs to whichever rule WON, including under `rule_conflict`:
   * "which flow" and "which board columns" must come from the same row, or a
   * ticket would run the narrow flow of one rule while being driven around
   * another's board.
   */
  statusMap?: StatusMap | null;
}

/**
 * How narrow each flow is — the fail-closed ordering.
 *
 * Lower is narrower. `analiz` writes no code at all: it produces a document a
 * human reads. `duzeltme` and `gelistirme` both put an agent on a branch. So
 * when rules disagree about a ticket the analysis flow is the safe answer,
 * because the cost of being wrong is a document nobody needed rather than a
 * change nobody asked for.
 *
 * This ordering is consulted ONLY to break a tie between rules that both
 * matched. It is not a default: a ticket no rule matched is not "ambiguous",
 * it is "unclassified", and that case falls through to the deployment default
 * instead (see `flowDecisionFor`).
 */
const NARROWNESS: Readonly<Record<FlowType, number>> = {
  analiz: 0,
  duzeltme: 1,
  gelistirme: 2,
};

/** Whether one rule matches one ticket. */
function matches(rule: ListeningRuleRecord, ticket: ClassifiableTicket): boolean {
  if (!rule.enabled) return false;
  // A rule belongs to its project; it never classifies another project's ticket.
  if (rule.projectKey !== ticket.projectKey) return false;

  // An empty `assigneeAccountId` means "whoever it is assigned to". A non-empty
  // one must equal the ticket's assignee — a ticket assigned to a human is not
  // Maestro's to run just because its status matches.
  const wanted = rule.assigneeAccountId.trim();
  if (wanted !== "" && wanted !== (ticket.assignee ?? "").trim()) return false;

  // `assigned` is the whole rule: the assignment check above IS the condition,
  // so there is nothing further to compare. It reaches this line only after
  // passing that check, which is why a rule with an EMPTY `assigneeAccountId`
  // and this kind matches every ticket in its project — deliberately, since
  // "whoever it is assigned to" plus "no further condition" is exactly what
  // such a rule says. `matchValue` is not consulted; see ASSIGNED_MATCH_VALUE.
  if (rule.matchKind === "assigned") return true;

  const field = fieldOf(rule.matchKind, ticket);
  // A field the payload did not carry matches NOTHING. Treating a missing
  // status as an empty string would let a rule with an empty `matchValue`
  // classify every ticket whose status simply was not delivered.
  return field !== null && field === rule.matchValue;
}

/**
 * The ticket field a rule of this kind compares against. Never called for
 * `assigned`, which compares no field — `matches` returns before it gets here.
 */
function fieldOf(kind: MatchKind, ticket: ClassifiableTicket): string | null {
  return kind === "status" ? ticket.status : ticket.issueType;
}

/**
 * How SPECIFIC a rule is — the ordering that keeps a catch-all from shouting
 * down the rule an operator wrote on purpose.
 *
 * Lower is more specific. A `status` or `issuetype` rule names a condition the
 * ticket had to satisfy; an `assigned` rule names none, so it is the answer of
 * last resort among the rules that matched. This is NOT a tie-break — it
 * outranks `priority`, because the two express different things: priority
 * orders rules an admin considers comparable, while specificity says one of
 * them was not really a competitor at all.
 *
 * Without it, the intended configuration — "Hata tickets get düzeltme, anything
 * else assigned to the bot gets analiz" — would report `rule_conflict` on EVERY
 * bug ticket, filling the audit trail with misconfiguration warnings about a
 * setup that is correct and that the wizard itself now produces.
 */
function specificityOf(rule: ListeningRuleRecord): number {
  return rule.matchKind === "assigned" ? 1 : 0;
}

/**
 * Every rule that matches this ticket, most important first.
 *
 * Ordered by specificity (a named condition beats the catch-all), then by
 * `priority` (lower wins, as the pilot and the Studio screen both present it),
 * then by `ruleId` so two rules sharing both still order DETERMINISTICALLY —
 * the same rule set must always produce the same decision, whatever order the
 * store handed the rows over in.
 */
export function rulesFor(
  rules: readonly ListeningRuleRecord[],
  ticket: ClassifiableTicket,
): readonly ListeningRuleRecord[] {
  return rules
    .filter((rule) => matches(rule, ticket))
    .sort(
      (a, b) =>
        specificityOf(a) - specificityOf(b) ||
        a.priority - b.priority ||
        a.ruleId.localeCompare(b.ruleId),
    );
}

/**
 * The single rule that classifies a ticket, or `null` when none does.
 *
 * The pilot's `ruleFor`, preserved: highest-priority match wins. The whole rule
 * is returned, not just its flow, so a caller can also read the agent-variant
 * mapping (`analystVariantId` / `engineerVariantId`) the rule carries.
 */
export function ruleFor(
  rules: readonly ListeningRuleRecord[],
  ticket: ClassifiableTicket,
): ListeningRuleRecord | null {
  const matched = rulesFor(rules, ticket);
  return matched.length === 0 ? null : { ...matched[0]! };
}

/**
 * Decide a ticket's flow, and say WHY.
 *
 * The reason is returned rather than logged here because the answer has to
 * reach an operator who asks "why did OPS-41 write code?" months later. The
 * caller writes it into the audit chain alongside the run; a decision that only
 * existed in a log line would be gone by then.
 *
 * Precedence, highest first:
 *  1. A single matching rule decides.
 *  2. A rule that names a CONDITION beats the `assigned` catch-all outright,
 *     with no conflict reported. The two are not competing claims about the
 *     same ticket: "Hata tickets run düzeltme" and "anything else assigned to
 *     the bot runs analiz" is one coherent setup — the very setup the wizard
 *     produces — and calling it a misconfiguration on every bug ticket would
 *     bury the real conflicts in noise.
 *  3. Several rules of the SAME specificity matching with DIFFERENT flows is a
 *     misconfiguration. It is resolved fail-closed — the narrowest flow of that
 *     set — and reported as `rule_conflict` so an admin can fix the rules. It is
 *     not refused: refusing would strand the ticket, and the narrow flow is
 *     safe. (The unique index on (projectKey, assigneeAccountId, matchKind,
 *     matchValue) stops the COMMON case at the database, but two rules can
 *     still match one ticket through different `matchKind`s — a status rule and
 *     an issuetype rule — which no index can prevent.)
 *  4. No rule matched: the deployment default (`flowOf(env)`) still applies, so
 *     an install that has no rules yet behaves exactly as it did before.
 */
export function flowDecisionFor(
  rules: readonly ListeningRuleRecord[],
  ticket: ClassifiableTicket,
  defaultFlow: FlowType | null | undefined,
): FlowDecision {
  const all = rulesFor(rules, ticket);

  if (all.length === 0) {
    return defaultFlow === undefined || defaultFlow === null
      ? { flow: null, reason: "none" }
      : { flow: defaultFlow, reason: "default" };
  }

  // Only the most specific tier competes. `rulesFor` has already sorted, so the
  // head's specificity is the winning tier and the catch-all drops out of the
  // conflict question entirely whenever a conditioned rule matched.
  const best = specificityOf(all[0]!);
  const matched = all.filter((rule) => specificityOf(rule) === best);

  const flows = new Set(matched.map((rule) => rule.flowType));
  if (flows.size === 1) {
    const winner = matched[0]!;
    return {
      flow: winner.flowType,
      reason: "rule",
      ruleId: winner.ruleId,
      statusMap: winner.statusMap ?? null,
    };
  }

  // Disagreement: take the narrowest flow any matching rule asked for, and name
  // every rule involved so the misconfiguration is fixable.
  const narrowest = [...matched].sort(
    (a, b) => NARROWNESS[a.flowType] - NARROWNESS[b.flowType] || a.priority - b.priority || a.ruleId.localeCompare(b.ruleId),
  )[0]!;
  return {
    flow: narrowest.flowType,
    reason: "rule_conflict",
    ruleId: narrowest.ruleId,
    conflictingRuleIds: matched.map((rule) => rule.ruleId),
    // From the rule that WON, not merged across the matching set: two maps
    // combined would drive the ticket to a column no single rule asked for,
    // which is a board move nobody configured and nobody can explain.
    statusMap: narrowest.statusMap ?? null,
  };
}
