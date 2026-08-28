import type { AuditStore } from "@maestro/audit";
import type { AuditEvent, DataClass } from "@maestro/contracts";
import { verifyChain } from "@maestro/audit";
import type {
  DecisionReader,
  DecisionRecord,
  PiiReader,
  PiiRuleStat,
  PiiSummaryStat,
} from "@maestro/bff";
import { PII_TYPES } from "@maestro/pii";

/**
 * The two auditor surfaces, both read from the M33 hash chain (`AuditLog`).
 *
 * The chain is the right source for both, and for the same reason: it is the
 * only store in this platform that is append-only and hash-linked, so a number
 * read from it can be checked. A summary table would be a second copy somebody
 * could update without the chain agreeing.
 *
 * Both readers share ONE `AuditStore` with the chain that appends — never a
 * second store over the same table. A reader with its own store verifies
 * itself, which proves nothing (M33).
 */

// ── PII (M20/M63) ─────────────────────────────────────────────────────────────

/**
 * Masking statistics, from `PII_MASKED` rows.
 *
 * SECURITY: the audit meta this reads is produced by `packages/pii`'s
 * `toAuditMeta`, which emits `maskedOccurrences`, `maskedFields` and
 * `maskedTypes` — counts and type NAMES. No value, no sample, no plaintext has
 * ever been written to these rows, so there is none here to leak. That is the
 * property the v1 finding cost us and the reason this reader takes the audit
 * trail as its source rather than anything closer to the masker.
 */
export class AuditPiiReader implements PiiReader {
  constructor(
    private readonly store: AuditStore,
    /** LLM calls, for the denominator and the on-prem count. */
    private readonly llmCalls: LlmCallStatDelegate,
  ) {}

  async stats(): Promise<{ summary: PiiSummaryStat; rules: readonly PiiRuleStat[] }> {
    const events = await this.store.read();
    const masked = events.filter((event) => event.action === "PII_MASKED");

    const totalCalls = await this.llmCalls.count({});
    // A call that never leaves the building is not an unmasked leak — it is
    // the policy working (M18/M63 send `gizli` work to the on-prem model).
    // Counted separately so the screen can say so rather than showing it as a
    // gap in coverage.
    const onPremCalls = await this.llmCalls.count({ where: { dataClass: "gizli" } });

    const byType = new Map<string, number>();
    let maskedFields = 0;
    for (const event of masked) {
      // Two spellings, because two writers exist. `packages/pii`'s
      // `toAuditMeta` emits `maskedFields`/`maskedTypes`; the rows already in
      // this database use `fields`/`kinds`. Reading only the first spelling
      // reported zero masked fields over a trail that plainly recorded two —
      // a wrong number is worse here than a missing one, because the screen
      // shows it as coverage.
      maskedFields += numberOf(event.meta["maskedFields"]) + numberOf(event.meta["fields"]);
      const occurrences = numberOf(event.meta["maskedOccurrences"]);
      const types = [...typesOf(event.meta["maskedTypes"]), ...typesOf(event.meta["kinds"])];
      for (const type of types) {
        byType.set(type, (byType.get(type) ?? 0) + Math.max(occurrences, 1));
      }
    }

    return {
      summary: {
        maskedCalls: masked.length,
        totalCalls,
        maskedFields,
        // No table records an exemption, and the policy loader forbids one:
        // `acik ⊆ dahili ⊆ gizli` is enforced at load, so a variant cannot be
        // configured to mask less. An empty list here is a real fact, not a
        // missing store — there is nothing that could add to it.
        exemptVariants: [],
        onPremCalls,
        // `packages/publish`'s archive path masks before writing (M56). This
        // reader cannot prove that from the chain, so it reports the design
        // invariant, and the day an unmasked archive is possible this must
        // become a probe rather than a constant.
        archiveMasked: true,
      },
      rules: rulesFrom(byType),
    };
  }
}

/**
 * Only what the counters need — `count`, never a row that could hold a value.
 *
 * `dataClass` is the contract's union rather than `string` because the column
 * is a Prisma enum and the generated client refuses a widened type. Same
 * refusal as `AuditLogWriteRow.action`, and the useful kind: a class this
 * platform can mint is always a class the column can store.
 */
export interface LlmCallStatDelegate {
  count(args: { where?: { dataClass?: DataClass } }): Promise<number>;
}

/**
 * One rule per detector type, with the hits the chain recorded.
 *
 * The rule identities come from `packages/pii`'s `PII_TYPES` — the real
 * detector set — so a type added there shows up here without anybody
 * maintaining a parallel list. `matcher` is the DETECTOR NAME, which is a
 * pattern identity (`iban`, `tckn`), and the strategy is how that type is
 * masked. Neither is, or could become, a value.
 */
function rulesFrom(byType: ReadonlyMap<string, number>): readonly PiiRuleStat[] {
  const known: PiiRuleStat[] = PII_TYPES.map((type) => ({
    ruleId: `pii.${type}`,
    // `field` is the M20 field-rule half; everything else is a regex detector.
    kind: type === "field" ? "field" : "regex",
    matcher: type,
    // Every detector mints a reversible token (`[TCKN_1.a3f9]`) rather than
    // deleting or truncating, so the model can reason about the entity it
    // never sees. That is `hash` in the screen's vocabulary.
    strategy: "hash",
    hits: byType.get(type) ?? 0,
  }));

  /**
   * Types the trail recorded that this build's detector set does not know.
   *
   * Dropping them would under-report masking against a chain that plainly
   * says otherwise, and the row an operator most needs to see is exactly the
   * one whose name this build does not recognise: it means the masker and the
   * reader disagree about the vocabulary. The name is a TYPE (`customer_no`),
   * which is a rule identity and not a value — the same class of string as
   * `iban`.
   */
  const unknown: PiiRuleStat[] = [...byType.entries()]
    .filter(([type]) => !(PII_TYPES as readonly string[]).includes(type))
    .map(([type, hits]) => ({
      ruleId: `pii.unknown.${type}`,
      kind: "regex",
      matcher: type,
      strategy: "hash",
      hits,
    }));

  return [...known, ...unknown];
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function typesOf(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

// ── decision ledger (M33) ─────────────────────────────────────────────────────

/** Audit actions that ARE a decision somebody made. */
const DECISION_ACTIONS: Readonly<Record<string, { severity: string; status: string }>> = {
  GATE_APPROVE: { severity: "info", status: "approved" },
  GATE_REJECT: { severity: "high", status: "rejected" },
  GATE_OPEN: { severity: "medium", status: "open" },
  MODE_CHANGED: { severity: "medium", status: "decided" },
  ASSIGN_APP: { severity: "low", status: "decided" },
  PARAM_CHANGED: { severity: "medium", status: "decided" },
  BINDING_CHANGED: { severity: "medium", status: "decided" },
  KILL_SWITCH: { severity: "critical", status: "decided" },
  SECURITY_SCAN_FAIL: { severity: "high", status: "open" },
};

/**
 * The decision ledger, derived from the chain.
 *
 * Every row carries the `seq` it came from and whether the chain still
 * recomputes, because the screen's job is to be evidence rather than a
 * summary. The verification is done HERE, per request, over the same events
 * the rows were built from — not read from a stored "verified" flag, which is
 * exactly what an attacker who rewrote the trail would also have rewritten.
 *
 * The cursor is the last `seq` returned. Sequence numbers are assigned under
 * the chain lock and never reused, so paging on them cannot skip or repeat a
 * row the way an offset can when rows are appended mid-page.
 */
export class AuditDecisionReader implements DecisionReader {
  constructor(private readonly store: AuditStore) {}

  async list(request: { limit: number; cursor: string | null }): Promise<{
    items: readonly DecisionRecord[];
    nextCursor: string | null;
  }> {
    const events = await this.store.read();

    // Verified over the WHOLE chain, not the page: a page that recomputes on
    // its own says nothing about a chain broken before it.
    const verification = verifyChain(events);
    const chainVerified = verification.ok;

    const decisions = events
      .filter((event) => DECISION_ACTIONS[event.action] !== undefined)
      .sort((left, right) => right.seq - left.seq);

    const after = cursorSeq(request.cursor);
    const page = (after === null ? decisions : decisions.filter((e) => e.seq < after)).slice(
      0,
      request.limit,
    );

    const last = page.at(-1);
    return {
      items: page.map((event) => toDecision(event, chainVerified)),
      nextCursor: last !== undefined && page.length === request.limit ? String(last.seq) : null,
    };
  }
}

function cursorSeq(cursor: string | null): number | null {
  if (cursor === null) return null;
  const seq = Number(cursor);
  // A cursor that is not a sequence number is treated as no cursor rather than
  // as an error: it can only come from a client that built one itself, and the
  // first page is the safe answer.
  return Number.isSafeInteger(seq) && seq > 0 ? seq : null;
}

function toDecision(event: AuditEvent, chainVerified: boolean): DecisionRecord {
  const rule = DECISION_ACTIONS[event.action] ?? { severity: "info", status: "decided" };
  return {
    decisionId: `audit-${event.seq}`,
    // The action IS the reference: there is no masterplan `ref` column, and
    // inventing an "M44" for a row that never carried one would be a citation
    // to nothing.
    ref: event.action,
    question: event.subject,
    /**
     * The action and the actor as SEPARATE fields.
     *
     * This used to be `${event.action} · ${event.actor}` — pre-joined, under a
     * comment claiming "the BFF does not send sentences (M104)". Joining them
     * server-side is what put `GATE_OPEN · maestro-worker` into a bank
     * auditor's decision column: `GATE_OPEN` is not a decision anyone made, it
     * is an enum member, and once concatenated the screen could no longer
     * translate either half. Sent apart, the screen renders
     * `audit.action.GATE_OPEN` → "Kapı onaya açıldı" and composes the line
     * itself.
     */
    action: event.action,
    actor: event.actor,
    severity: rule.severity,
    status: rule.status,
    decidedAt: event.at,
    basis: { auditSeq: event.seq, chainVerified },
  };
}
