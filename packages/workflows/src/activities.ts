import type {
  AnalysisDoc,
  CiResultSignal,
  DataClass,
  GateDecision,
  MatchResult,
  RiskTier,
  ScanResult,
  StepId,
  TicketKey,
  WorkMode,
} from "@maestro/contracts";

/**
 * The workflow's whole contact with the world.
 *
 * A Temporal workflow must be deterministic and may not touch I/O, so every
 * side effect lives behind this interface and is implemented in
 * `packages/workflows/src/impl` against the wave 1-2 ports. Keeping the shape
 * here (and not in the implementation) is what lets the workflow be tested with
 * `TestWorkflowEnvironment` and a stub: sixteen days of waiting take
 * milliseconds because nothing real is called.
 */

export interface IntakeResult {
  complete: boolean;
  /** Present when the ticket is missing something (step 2b, M98). */
  question?: string;
}

export interface EngineeringResult {
  ok: boolean;
  resumeToken: string;
  changedFiles: number;
  diffSummary: string;
  /** Set when the agent gave up or hit a protected path (M52/M54). */
  handoverReason?: string;
}

export interface ReviewResult {
  approved: boolean;
  findings: string[];
}

export interface TestRunResult {
  passed: boolean;
  total: number;
  failed: number;
  coveragePct: number;
}

export type GateVerdict = { accepted: true } | { accepted: false; reason: string };

/**
 * The five moments a listening rule may map to a Jira status. They are named
 * after what HAPPENED to the ticket, not after the step number that happened to
 * be running: a step is an implementation detail that gets renumbered, while
 * "Maestro is now waiting on the reporter" is the fact an operator's board is
 * modelling. The names match `StatusMap`'s fields in `apps/bff` minus the `on`
 * prefix, so a journal line and the rule's JSON read as the same vocabulary.
 */
export type StatusMovePoint = "start" | "need_info" | "review" | "rejected" | "done";

/**
 * One request to move the ticket on the board.
 *
 * `status` is OPTIONAL because the two halves of `need_info` are independent:
 * an operator may map `reassignOnNeedInfo` without `onNeedInfo` (their board
 * models "waiting on the reporter" as an assignee, not as a column), and asking
 * for the assignment alone must not invent a status to move to.
 */
export interface StatusMoveRequest {
  at: StatusMovePoint;
  /** The status NAME the rule asked for; absent means "do not move, only assign". */
  status?: string;
  /** `reassignOnNeedInfo`: hand the ticket back to its reporter as well. */
  toReporter?: boolean;
}

/**
 * What the move actually did. Returned rather than thrown — see
 * `moveTicketStatus` — so a caller could branch on it; today nobody does,
 * because the policy is the same everywhere: warn, and carry on.
 */
export interface StatusMoveResult {
  moved: boolean;
  /** Why not, when `moved` is false: `already`, `forbidden`, `no_capability`… */
  reason?: string;
  /** Whether the ticket was also handed back to its reporter. */
  reassigned: boolean;
}

export interface PrRef {
  adoProject: string;
  adoRepo: string;
  prId: number;
}

export interface MaestroActivities {
  // ── step 0-3: intake, matching, analysis ────────────────────────────────
  resolveWorkMode(ticket: TicketKey): Promise<{ mode: WorkMode; dataClass: DataClass }>;
  matchApplication(ticket: TicketKey): Promise<MatchResult | null>;
  runIntake(ticket: TicketKey): Promise<IntakeResult>;
  askClarification(ticket: TicketKey, question: string): Promise<void>;
  discoverRepo(ticket: TicketKey, appId: string): Promise<{ files: number; modules: string[] }>;
  /**
   * `appId` is optional for the same reason `TicketWorkflowInput.appId` is: an
   * analysis-only binding has no application, and the workflow still schedules
   * this step — the document is then written from the ticket text alone.
   * (`discoverRepo` above keeps a REQUIRED appId: the workflow simply does not
   * schedule discovery when there is no repository to discover.)
   */
  writeAnalysis(ticket: TicketKey, appId?: string): Promise<{ analysis: AnalysisDoc; risk: RiskTier }>;
  publishAnalysis(ticket: TicketKey, analysis: AnalysisDoc): Promise<void>;
  fanOutChildren(ticket: TicketKey, analysis: AnalysisDoc): Promise<TicketKey[]>;

  // ── gates ───────────────────────────────────────────────────────────────
  /**
   * Opens the gate and answers with the DIRECTORY group it was opened against
   * — which is not necessarily the role that was asked for; see
   * `DirectoryReader.groupForRole`.
   */
  openGate(ticket: TicketKey, step: StepId, ownerGroup: string): Promise<string>;
  /**
   * Persist a decision — and report whether the DIRECTORY accepted it.
   * `gates.ts` can only check what the payload claims; group membership is a
   * live lookup, so its verdict has to come back here. A refusal must leave the
   * gate open and tell the person why, never fail the run.
   */
  recordGateDecision(ticket: TicketKey, decision: GateDecision): Promise<GateVerdict>;
  /**
   * Is this user a master admin (four-eyes group)? A live directory lookup, so
   * it is an activity, not something the deterministic workflow can decide.
   *
   * Used ONLY to waive the cross-gate "two different signatures" rule (M32/M92)
   * for a single master admin, so a one-admin install is not deadlocked at the
   * analysis or QA gates. Every other gate check (step, group, membership)
   * still applies; the solo approval is recorded in the audit trail by
   * `recordGateDecision`.
   */
  isMasterApprover(userId: string): Promise<boolean>;
  /** Reminder ladder tick (M88); returns the next due moment, or null when done. */
  escalateGate(ticket: TicketKey, step: StepId, waitingHours: number): Promise<string | null>;

  // ── step 6-10: engineering, scanning, review, tests ──────────────────────
  runEngineering(
    ticket: TicketKey,
    resumeToken: string | null,
    task: string,
    attempt?: number,
  ): Promise<EngineeringResult>;
  /**
   * `attempt` distinguishes one lap of the M54 loop from the next. Without it
   * the idempotency key would have to come from the results, and three rounds
   * that failed identically would collapse into a single record — the evidence
   * package would then under-report what was actually run.
   */
  runScans(ticket: TicketKey, attempt?: number): Promise<ScanResult[]>;
  reviewDiff(ticket: TicketKey, attempt?: number): Promise<ReviewResult>;
  designTests(ticket: TicketKey, attempt?: number): Promise<{ scenarios: number }>;
  reviewTests(ticket: TicketKey, attempt?: number): Promise<ReviewResult>;
  runTests(ticket: TicketKey, attempt?: number): Promise<TestRunResult>;

  // ── step 10b-13: PR, CI, closure ─────────────────────────────────────────
  openPullRequest(ticket: TicketKey): Promise<PrRef>;
  activatePullRequest(ticket: TicketKey, pr: PrRef): Promise<void>;
  /** Rejects a signal whose origin does not match the run's application (M106). */
  verifyCiOrigin(ticket: TicketKey, signal: CiResultSignal): Promise<boolean>;
  mergePullRequest(ticket: TicketKey, pr: PrRef): Promise<{ mergeSha: string }>;
  buildEvidencePackage(ticket: TicketKey): Promise<{ files: number; storageKey: string }>;
  /**
   * The `analiz` flow's delivery: hand the approved analysis back to whoever
   * asked for it. Fail-soft — see the implementation for why.
   */
  deliverAnalysis(ticket: TicketKey, analysis: AnalysisDoc | null): Promise<void>;
  closeTicket(ticket: TicketKey): Promise<void>;

  // ── cross-cutting ────────────────────────────────────────────────────────
  /**
   * Move the ticket to the status the run's listening rule asked for, and say
   * what happened.
   *
   * WARN BUT CONTINUE, without exception. This resolves rather than rejects for
   * every outcome — a status the board does not offer, a service account that
   * may not transition, a driver with no transition API at all — and journals
   * the reason itself. A failed board move is a cosmetic loss; the analysis and
   * the approvals are the deliverable, and neither is worth losing to it.
   *
   * The workflow only calls this when the rule NAMED something for that point,
   * so a comment-only run schedules no activity here at all — the run's history
   * is then byte-identical to what it was before the status map existed.
   */
  moveTicketStatus(ticket: TicketKey, move: StatusMoveRequest): Promise<StatusMoveResult>;
  journal(ticket: TicketKey, kind: string, title: string, detail: string): Promise<void>;
  handOverToHuman(ticket: TicketKey, reason: string): Promise<void>;
}
