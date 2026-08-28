/**
 * The listening-rule store seam ("dinleme kuralları" surface).
 *
 * A `ListeningRule` says: in project `projectKey`, a ticket assigned to
 * `assigneeAccountId` (the Maestro Bot) whose `matchKind` field equals
 * `matchValue` should be picked up and run as `flowType`. It turns Maestro's
 * hard-coded, single-project, type-blind discovery (`apps/pilot/src/config.ts`
 * `discoveryJql`) into rows an admin edits from Studio — the "tüm ayarlar UI'dan"
 * posture.
 *
 * Structural, like every other store the composition root supplies (M44): no
 * file under `src/routes` imports Prisma, and every test drives an in-memory
 * fake. The rule types live HERE, not in `@maestro/contracts`: the frozen
 * `RuleCondition` only knows always|component|label, and `flowType`/`matchKind`
 * are a presentation vocabulary, so they are new types in the BFF rather than an
 * edit to the frozen schema (matching how the Jira-workflow read model was put
 * outside contracts for the same reason).
 */

import { z } from "zod";

/** The three flows Maestro can run a ticket through. Mirrors the DB CHECK. */
export type FlowType = "analiz" | "duzeltme" | "gelistirme";

/**
 * Which ticket field a rule matches on. Mirrors the DB CHECK (migration 0020).
 *
 * `assigned` is the odd one and is deliberately in the same enum rather than a
 * separate flag: it matches NO field at all. The rule fires on the assignment
 * alone — "whatever this ticket is, a human handed it to the bot, work it" —
 * which is the trigger most first-time operators actually want and the one the
 * two-member domain made unsayable. See `ASSIGNED_MATCH_VALUE` for why such a
 * rule still carries a value.
 */
export type MatchKind = "status" | "issuetype" | "assigned";

export const FLOW_TYPES: readonly FlowType[] = ["analiz", "duzeltme", "gelistirme"];
export const MATCH_KINDS: readonly MatchKind[] = ["status", "issuetype", "assigned"];

/**
 * The value an `assigned` rule stores. NOT a wildcard anybody interprets — no
 * matcher ever reads it — but the column is NOT NULL and the unique index on
 * (projectKey, assigneeAccountId, matchKind, matchValue) is what makes "one
 * catch-all rule per project and bot" a database fact instead of a convention
 * the UI is trusted to keep. A NULL would defeat that index outright, since
 * NULLs never collide in Postgres.
 */
export const ASSIGNED_MATCH_VALUE = "*";

/**
 * A status NAME as a rule may name it. Names, never Jira transition ids: an id
 * belongs to one project's workflow, so a rule copied to a second project would
 * silently drive the wrong transitions, whereas the name is the same string the
 * operator reads on their own board.
 */
const StatusName = z.string().trim().min(1).max(128);

/**
 * The OPTIONAL Jira status map ("durum eşlemesi").
 *
 * Two modes, distinguished by presence alone:
 *
 *   mode A (map is NULL)  comment-only. Maestro narrates progress in comments
 *                         and never moves the ticket. This is what every rule
 *                         written before this map existed does, and it stays
 *                         the default — driving somebody's board uninvited is
 *                         the kind of surprise that gets an automation banned.
 *   mode B (map present)  transition mode, for the points the operator mapped.
 *
 * EVERY field is optional, and that is load-bearing rather than lenient: an
 * absent field means "do not move the ticket at that point", so an operator who
 * only cares that finished work lands in 'Tamam' writes `{ onDone: "Tamam" }`
 * and Maestro leaves the rest of their workflow alone. There is no partially
 * valid map — either the document parses whole, or the rule falls back to
 * comment-only.
 *
 * `.strict()` because an unknown key here is never harmless: `onDoneX` would be
 * silently dropped and the operator would watch tickets never reach 'Tamam'
 * with nothing in the UI to explain it. A 400 at write time is the only place
 * that typo is cheap to fix.
 */
export const StatusMapSchema = z
  .object({
    /** Moving to work — e.g. "Devam Ediyor". */
    onStart: StatusName.optional(),
    /** Maestro needs more information from the reporter — e.g. "Yapılacaklar". */
    onNeedInfo: StatusName.optional(),
    /** Analysis published, awaiting human approval — e.g. "İNCELEMEDE". */
    onReview: StatusName.optional(),
    /** An approver rejected; the work goes back to analysis — e.g. "Devam Ediyor". */
    onRejected: StatusName.optional(),
    /** Delivered — e.g. "Tamam". */
    onDone: StatusName.optional(),
    /**
     * Whether asking for information also hands the ticket BACK to its reporter.
     * Separate from `onNeedInfo` on purpose: a board where "waiting on the
     * reporter" is a status and one where it is an assignee are both real, and
     * an operator may want either, both, or neither.
     */
    reassignOnNeedInfo: z.boolean().optional(),
  })
  .strict();

/** The parsed Jira status map. `null` on a rule means comment-only mode. */
export type StatusMap = z.infer<typeof StatusMapSchema>;

/**
 * Parse a `statusMapJson` column value, FAIL-SAFE.
 *
 * The read path must never be the thing that takes discovery down. A map that
 * does not parse — hand-edited SQL, a shape from a future version, a column
 * someone filled with a string — degrades to `null`, which is comment-only
 * mode: Maestro keeps running the flow and simply stops moving the ticket. The
 * alternative, throwing, would mean one malformed row stops every rule from
 * being read, and the blast radius of a bad map has to be smaller than that.
 *
 * `onInvalid` is how the caller reports the degradation, because silently
 * downgrading a rule an operator deliberately configured is its own failure —
 * the store logs it so the map's absence is explainable, not mysterious.
 */
export function parseStatusMap(
  value: unknown,
  onInvalid?: (reason: string) => void,
): StatusMap | null {
  // NULL column and the JSON literal `null` are the same thing here: no map.
  if (value === null || value === undefined) return null;
  const parsed = StatusMapSchema.safeParse(value);
  if (!parsed.success) {
    onInvalid?.(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "));
    return null;
  }
  // An empty object maps nothing, so it is indistinguishable from comment-only
  // mode in behaviour. Normalising it to null keeps ONE representation of "this
  // rule does not move tickets" rather than two that read differently.
  return Object.keys(parsed.data).length === 0 ? null : parsed.data;
}

/** One listening rule as stored. */
export interface ListeningRuleRecord {
  ruleId: string;
  projectKey: string;
  /** The account a ticket must be assigned to (the Maestro Bot accountId). */
  assigneeAccountId: string;
  matchKind: MatchKind;
  /** The status name or issue-type name that triggers this rule. */
  matchValue: string;
  flowType: FlowType;
  priority: number;
  enabled: boolean;
  /**
   * Which agent variant runs the ANALYSIS side of this flow (Faz 3). `null` (or
   * absent, for rows written before the column existed) means "the default
   * agent" — the pilot picks its own. Optional so the Prisma delegate in
   * `apps/deploy` compiles before its column mapping lands.
   */
  analystVariantId?: string | null;
  /** Same as `analystVariantId`, for the ENGINEERING (coding) side. */
  engineerVariantId?: string | null;
  /**
   * The optional Jira status map. `null` (or absent, for rows written before the
   * column existed) is comment-only mode — Maestro narrates in comments and
   * never moves the ticket, which is what every rule did before this landed.
   * Non-null opts this rule into transition mode for the points it names.
   */
  statusMap?: StatusMap | null;
}

/**
 * The fields a caller supplies to create/replace a rule. `ruleId` is assigned by
 * the service on create; on update it is the path param, not the body.
 */
export type ListeningRuleWrite = Omit<ListeningRuleRecord, "ruleId">;

export interface ListeningStore {
  /** Every rule, ordered by (projectKey, priority) for a stable screen. */
  list(): Promise<readonly ListeningRuleRecord[]>;
  /** One rule, or null when it does not exist. */
  get(ruleId: string): Promise<ListeningRuleRecord | null>;
  /**
   * Create or replace a rule by id. The unique (projectKey, assigneeAccountId,
   * matchKind, matchValue) index means a duplicate trigger is rejected by the
   * database — the service maps that to a 409.
   */
  put(record: ListeningRuleRecord): Promise<void>;
  /** Remove a rule. Returns false when it did not exist. */
  remove(ruleId: string): Promise<boolean>;
}
