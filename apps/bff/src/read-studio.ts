import type { LlmRole } from "@maestro/contracts";

/**
 * The read side for the last eight Studio screens (M7).
 *
 * A separate file from `read-models.ts` for one reason: the twelve read models
 * there are injected as ONE `ReadModels` bag that every route already shares,
 * and growing that bag breaks `unbridgedReadModels`, `liveReadModels` and every
 * test fixture at once. These four are optional, model-by-model, so a
 * deployment that has variant data but no golden-ticket table can wire the one
 * and refuse the other — which is exactly the situation this repo is in.
 *
 * `undefined` is NOT "empty". A composition root that leaves one of these out
 * gets a 503 with a named reason from the route; it never gets an empty list,
 * because an empty variant catalogue and an unwired variant store render
 * identically on screen and only one of them is true.
 */

// ── variants (M38) ────────────────────────────────────────────────────────────

/** One row of the variant catalogue. Numbers are counts, never prose. */
export interface VariantSummary {
  readonly variantId: string;
  readonly role: LlmRole;
  /** The variant's platform overlay: `web`, `mobile-ios`, `desktop`… (M38). */
  readonly platform: string;
  readonly model: string;
  readonly activeVersion: number;
  readonly knowledgeFiles: number;
  /**
   * The active version's eval score, or `null` for "never evaluated".
   *
   * `null` and `0` are different facts and the screen renders them
   * differently: a variant nobody has scored is not a variant that scored
   * zero, and collapsing the two would let an unevaluated prompt look failed
   * (or, worse, let a failed one look merely unmeasured).
   */
  readonly evalScore: number | null;
}

export interface VariantVersionRecord {
  readonly version: number;
  readonly publishedAt: string;
  readonly publishedBy: string;
  readonly note: string;
  readonly evalScore: number | null;
}

/** A knowledge file the variant's prompt is built from (M18/M63). */
export interface VariantKnowledgeLink {
  readonly docId: string;
  readonly fileName: string;
  readonly category: string;
  readonly version: number;
}

export interface VariantDetail extends Omit<VariantSummary, "knowledgeFiles" | "evalScore"> {
  readonly persona: string;
  readonly knowledge: readonly VariantKnowledgeLink[];
  readonly versions: readonly VariantVersionRecord[];
}

export interface VariantCatalog {
  list(): Promise<readonly VariantSummary[]>;
  /** `null` when no such variant — the route answers 404, never a blank detail. */
  get(variantId: string): Promise<VariantDetail | null>;
}

// ── variant WRITES (M38 / M83) ────────────────────────────────────────────────

/**
 * Creating a variant, and publishing a new version of one.
 *
 * A SEPARATE interface from `VariantCatalog` on purpose: reading the catalogue
 * is something a deployment may wire over any store (the shipped one is
 * Postgres-backed and read-only), but WRITING needs a store that can append an
 * immutable version and reject a stale one. A deployment that wires the read
 * catalogue but not the writer gets a 503 on every write and keeps its read
 * screens — the two capabilities are independent, exactly like `pii` and
 * `decisions` are independent of `variants`.
 *
 * The rule the writer must keep is M83: a version is APPENDED, never mutated.
 * `publishVersion` writes `latest + 1` and must reject anything else, so two
 * authors publishing at once cannot both become version 8 with one prompt
 * silently lost — the same guarantee the template and doc-template stores make.
 */
export interface VariantWriteFields {
  /** The gateway model this version calls (`claude-opus-5`, …). */
  readonly model: string;
  /** The persona/prompt overlay this version carries. */
  readonly persona: string;
  /** Knowledge file references the prompt is built from (M18/M63). */
  readonly knowledgeRefs: readonly string[];
  /** Author's note for the version history. "" is allowed. */
  readonly note: string;
}

export interface VariantCreateRequest {
  readonly variantId: string;
  readonly role: LlmRole;
  readonly platform: string;
  readonly fields: VariantWriteFields;
  /** Audit actor of the caller (M33). */
  readonly actor: string;
  /** When the first version is published. */
  readonly at: string;
}

export interface VariantVersionRequest {
  readonly variantId: string;
  readonly fields: VariantWriteFields;
  readonly actor: string;
  readonly at: string;
}

export interface VariantEditRequest {
  readonly variantId: string;
  /** The platform overlay may be corrected without publishing a version. */
  readonly platform: string;
  readonly actor: string;
  readonly at: string;
}

export interface VariantWriter {
  /**
   * Create a variant and publish its version 1. MUST reject a `variantId` that
   * already exists — creating over a variant would silently orphan its history.
   */
  create(request: VariantCreateRequest): Promise<VariantDetail>;
  /**
   * Edit the variant's non-versioned metadata (its platform overlay). The model
   * and persona are versioned, so changing THEM goes through `publishVersion`,
   * never here — an in-place model change is exactly the mutation M83 forbids.
   * Rejects an unknown variant (the route answers 404).
   */
  edit(request: VariantEditRequest): Promise<VariantDetail | null>;
  /**
   * Append a new immutable version (`latest + 1`). Rejects an unknown variant
   * (404) and a stale expected version (the store owns the sequence).
   */
  publishVersion(request: VariantVersionRequest): Promise<VariantDetail | null>;
}

// ── golden-ticket eval (M38/M43/M78) ──────────────────────────────────────────

/**
 * A reference ticket the eval pool replays. `lastScore` is the most recent
 * score this golden ticket received, or `null` before it has ever been scored —
 * never `0`, which is a failing score and a different fact.
 */
export interface GoldenTicket {
  readonly goldenId: string;
  readonly sourceTicket: string;
  readonly kind: string;
  readonly expectation: string;
  readonly lastScore: number | null;
}

export interface EvalRunResult {
  readonly goldenId: string;
  readonly baselineScore: number | null;
  readonly candidateScore: number | null;
}

/**
 * One eval run: a candidate variant version replayed against the pool and
 * compared to the baseline it would replace.
 *
 * `decision` records the M78 gate outcome: a run with a regression may only be
 * `shipped` with a written `justification`. `pending` is the state before a
 * human has decided; `blocked` is a regression that was refused.
 */
export interface EvalRunRecord {
  readonly runId: string;
  readonly variantId: string;
  readonly baselineVersion: number;
  readonly candidateVersion: number;
  readonly at: string;
  readonly results: readonly EvalRunResult[];
  readonly decision: EvalDecision;
}

export type EvalDecisionStatus = "pending" | "shipped" | "blocked";

export interface EvalDecision {
  readonly status: EvalDecisionStatus;
  /** Non-empty exactly when a regression was shipped anyway (M78). */
  readonly justification: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
}

export interface EvalRecordDecisionRequest {
  readonly runId: string;
  readonly status: Exclude<EvalDecisionStatus, "pending">;
  readonly justification: string;
  readonly actor: string;
  readonly at: string;
}

/**
 * The eval producer. This is what makes `/eval` answerable AT ALL: without a
 * store that records golden tickets and eval runs there is nothing to read, and
 * the route refuses by name rather than rendering an empty pool as "no
 * regressions" (see `routes/unwired.ts`). Wiring one is what turns the screen
 * on — the same rule every unwired capability follows.
 */
export interface EvalReader {
  pool(): Promise<readonly GoldenTicket[]>;
  /** The most recent eval run, or `null` before any has been recorded. */
  lastRun(): Promise<EvalRunRecord | null>;
  /** A specific run — how the decision path re-reads what it is deciding on. */
  run(runId: string): Promise<EvalRunRecord | null>;
}

export interface EvalWriter extends EvalReader {
  /**
   * Record the M78 gate decision on a run. Returns the updated run, or `null`
   * when the run is unknown (404). The service — not the store — enforces that
   * shipping a run WITH a regression requires a justification.
   */
  recordDecision(request: EvalRecordDecisionRequest): Promise<EvalRunRecord | null>;
}

// ── PII masking (M20/M63) ─────────────────────────────────────────────────────

/**
 * One masking rule and how often it fired.
 *
 * SECURITY: `matcher` is a FIELD NAME or a PATTERN — never a value, and never a
 * sample of one. The v1 audit finding was a "second copy" of the masked value
 * kept for display, so this interface has no field that could carry one, and
 * the store that fills it reads counts out of the audit trail rather than
 * anything that ever held plaintext.
 */
export interface PiiRuleStat {
  readonly ruleId: string;
  /** `field` | `regex` — what the rule matches ON. */
  readonly kind: string;
  /** The field name or the detector's pattern name. NOT a value. */
  readonly matcher: string;
  /** `hash` | `redact` | `partial` */
  readonly strategy: string;
  /** How many times the rule fired in the window. A count, never a value. */
  readonly hits: number;
}

export interface PiiSummaryStat {
  readonly maskedCalls: number;
  readonly totalCalls: number;
  readonly maskedFields: number;
  /** Variants exempted from masking; an exemption is a risk, so it is shown. */
  readonly exemptVariants: readonly string[];
  /** Calls that went to an on-prem model unmasked because they never leave. */
  readonly onPremCalls: number;
  /** Whether the archive stores the masked form (must be true). */
  readonly archiveMasked: boolean;
}

export interface PiiReader {
  stats(): Promise<{ summary: PiiSummaryStat; rules: readonly PiiRuleStat[] }>;
}

// ── decision ledger (M33 audit) ───────────────────────────────────────────────

/**
 * A decision as the "sorunlar" screen reads it.
 *
 * `basis` is what makes the row auditable rather than merely displayed: it
 * names the audit sequence numbers the row was derived from, so an operator
 * can go and read the same chain. A ledger that says "verified" without saying
 * verified-against-what is a claim, not evidence.
 */
export interface DecisionRecord {
  readonly decisionId: string;
  /** Masterplan reference, or the audit action when the row carries no `ref`. */
  readonly ref: string;
  readonly question: string;
  /**
   * The decision as its two machine parts: the audit action and who took it.
   *
   * Deliberately NOT a joined `"GATE_OPEN · maestro-worker"` string, which is
   * what this used to be. Joined, neither half could be translated, and a bank
   * auditor read a raw enum in the column headed "Karar". The screen renders
   * `audit.action.${action}` and composes the line.
   */
  readonly action: string;
  readonly actor: string;
  readonly severity: string;
  readonly status: string;
  readonly decidedAt: string;
  /** The audit rows this was read from, and whether the chain still verifies. */
  readonly basis: {
    readonly auditSeq: number;
    readonly chainVerified: boolean;
  };
}

export interface DecisionReader {
  list(request: { limit: number; cursor: string | null }): Promise<{
    readonly items: readonly DecisionRecord[];
    readonly nextCursor: string | null;
  }>;
}

/**
 * The optional read models the last eight screens need; see the file docblock.
 *
 * There is deliberately NO `workspaces` model here. `/cache` needs a runner id,
 * a size on disk and a session state per workspace, and this platform has no
 * `runner` in its schema and no size probe on `RunnerPort` — so an interface
 * for it would be one a composition root could only fill by inventing the
 * numbers. The route refuses by name instead (`routes/unwired.ts`), which is
 * the same treatment `runners` and `scans` already get.
 */
export interface StudioReadModels {
  variants?: VariantCatalog;
  /**
   * The variant WRITE side (create/edit/publish-version). Optional and separate
   * from `variants`: a deployment may wire a read-only catalogue without a
   * writer, and the write routes refuse by name (503) rather than pretend to
   * save. When present, the create/edit/version endpoints work for real.
   */
  variantWriter?: VariantWriter;
  pii?: PiiReader;
  decisions?: DecisionReader;
  /**
   * The golden-ticket eval producer (M38/M43/M78). Its PRESENCE is what turns
   * `/eval` from a refusal into a real screen: with nothing wired the route
   * still 503s by name, because an empty pool renders as "no regressions" on a
   * platform that has never measured one.
   */
  eval?: EvalWriter;
}
