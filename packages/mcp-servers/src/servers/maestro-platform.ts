import type {
  DataClass,
  JournalEntry,
  ParamKey,
  RepoCard,
  WorkflowRunState,
  WorkflowRunStatus,
  WorkMode,
} from "@maestro/contracts";

/** A run as `get_run` returns it: the contract state plus what a human would ask next. */
export interface RunDetail {
  readonly state: WorkflowRunState;
  readonly appId: string | null;
  readonly mode: WorkMode;
  /** Set while the run sits on a human gate — who owns it and since when (M101 read scope). */
  readonly pendingGate: {
    readonly step: string;
    readonly ownerGroup: string;
    readonly openedAt: string;
    readonly waitingDays: number;
  } | null;
}

export interface ParamView {
  readonly key: ParamKey;
  readonly scope: string;
  readonly scopeRef: string | null;
  readonly value: unknown;
  readonly guarded: boolean;
  readonly version: number;
}

/**
 * The result of `propose_param_change`. `status` is a single literal on
 * purpose: there is no shape this type can take that means "applied". A
 * platform implementation that applied the change would have to lie about its
 * return value, and `maestroMcpServer` checks the value it gets back.
 */
export interface ParamChangeProposal {
  readonly proposalId: string;
  readonly key: ParamKey;
  readonly scopeRef: string | null;
  readonly status: "pending_four_eyes";
  /** Group that must supply the second pair of eyes (M71 guarded params, M32). */
  readonly approverGroup: string;
}

/**
 * The same shape for a kill-switch (M58). `toggle_killswitch` is deliberately
 * not a tool: stopping the platform — or resuming it after an incident — is a
 * two-approval decision, and one that an AI holding a borrowed token must not
 * be able to make on a hunch. MCP files the proposal; a second human approves
 * it in Studio, exactly as with a guarded parameter.
 */
export interface KillSwitchProposal {
  readonly proposalId: string;
  readonly level: KillSwitchLevel;
  readonly status: "pending_four_eyes";
  readonly approverGroup: string;
}

/** M58's two levels: stop taking new work, or stop everything. */
export type KillSwitchLevel = "pause_intake" | "stop_all";

export interface KnowledgeHit {
  readonly id: string;
  readonly title: string;
  readonly snippet: string;
  readonly source: string;
  readonly score: number;
  /**
   * The institution's own classification of the document (M18/M63).
   *
   * REQUIRED, deliberately: it used to be optional and an unlabelled hit was
   * read as `dahili`, so an unlabelled confidential document reached the IDE
   * channel. Guessing the safe answer is the adapter's job, not this
   * interface's — an index that cannot say MUST report `gizli`, which is what
   * every other unknown-class path in this system does (M18/M63 fail-closed).
   * On the `maestro-mcp` channel a `gizli` hit is dropped rather than masked
   * (`src/ide-boundary.ts`, B9).
   */
  readonly dataClass: DataClass;
}

/** A gate waiting on a human, as `list_pending_gates` reports it (M101 read). */
export interface PendingGate {
  readonly runId: string;
  readonly ticketKey: string;
  readonly step: string;
  readonly ownerGroup: string;
  readonly openedAt: string;
  readonly waitingDays: number;
}

/** LLM/token budget state (M101 read scope: "kota"). */
export interface QuotaStatus {
  readonly scope: string;
  readonly scopeRef: string | null;
  readonly usedTokens: number;
  readonly limitTokens: number;
  readonly windowEndsAt: string;
  readonly throttled: boolean;
}

/** Runner fleet health (M101 read scope: "runner sağlığı"). */
export interface RunnerHealth {
  readonly runnerId: string;
  readonly platform: string;
  readonly state: "idle" | "busy" | "draining" | "unreachable";
  readonly activeSandboxes: number;
  readonly lastHeartbeatAt: string;
}

/**
 * Everything `maestro-mcp` needs from the platform (M101), as one injected
 * interface. The BFF implements it over the DB, the workflow client and the
 * knowledge index; this package imports none of those (M44).
 *
 * Every method takes `actingUser`: the platform applies THAT user's RBAC. The
 * MCP layer checks tool scopes, which is a coarse filter over what the tool
 * category is; it is not, and must not be mistaken for, the row-level
 * authorisation the platform already owns. An AI holding a token gets exactly
 * what the person holding it would get — no wider, and nothing extra because
 * the request arrived over MCP.
 *
 * Note what is NOT on this interface: there is no method that closes a gate,
 * sets a run's verdict or merges a PR. That absence, not the name check in
 * `src/forbidden-tools.ts`, is what makes a gate decision unreachable from MCP.
 */
export interface MaestroPlatform {
  listRuns(
    actingUser: string,
    filter: {
      status: WorkflowRunStatus | undefined;
      ticketKey: string | undefined;
      appId: string | undefined;
      limit: number;
    },
  ): Promise<readonly WorkflowRunState[]>;

  getRun(actingUser: string, runId: string): Promise<RunDetail>;

  getJournal(
    actingUser: string,
    runId: string,
    range: { fromSeq: number; limit: number },
  ): Promise<readonly JournalEntry[]>;

  getParams(
    actingUser: string,
    filter: { scope: string | undefined; scopeRef: string | undefined },
  ): Promise<readonly ParamView[]>;

  /** MUST enqueue for four-eyes review and MUST NOT apply the change (M71/M101). */
  proposeParamChange(
    actingUser: string,
    proposal: { key: string; scopeRef: string | null; value: unknown; reason: string },
  ): Promise<ParamChangeProposal>;

  /** MUST enqueue for four-eyes review and MUST NOT flip the switch (M58/M101). */
  proposeKillSwitch(
    actingUser: string,
    proposal: { level: KillSwitchLevel; reason: string },
  ): Promise<KillSwitchProposal>;

  startWorkflow(
    actingUser: string,
    args: { ticketKey: string; mode: WorkMode | undefined },
  ): Promise<{ runId: string; ticketKey: string }>;

  assignApp(
    actingUser: string,
    args: { ticketKey: string; appId: string },
  ): Promise<{ ticketKey: string; appId: string }>;

  getRepoCard(actingUser: string, appId: string): Promise<RepoCard>;

  searchKnowledge(
    actingUser: string,
    query: { text: string; appId: string | undefined; limit: number },
  ): Promise<readonly KnowledgeHit[]>;

  listPendingGates(
    actingUser: string,
    filter: { ownerGroup: string | undefined; olderThanDays: number | undefined; limit: number },
  ): Promise<readonly PendingGate[]>;

  quotaStatus(
    actingUser: string,
    filter: { scope: string | undefined; scopeRef: string | undefined },
  ): Promise<readonly QuotaStatus[]>;

  runnerHealth(actingUser: string): Promise<readonly RunnerHealth[]>;

  setWorkMode(
    actingUser: string,
    args: { runId: string; mode: WorkMode; reason: string },
  ): Promise<{ runId: string; mode: WorkMode }>;

  pauseRun(actingUser: string, args: { runId: string; reason: string }): Promise<{ runId: string; status: string }>;

  resumeRun(actingUser: string, args: { runId: string; reason: string }): Promise<{ runId: string; status: string }>;

  retryStep(
    actingUser: string,
    args: { runId: string; step: string; reason: string },
  ): Promise<{ runId: string; step: string; attempt: number }>;

  /**
   * Reminds the gate's owner that it is waiting. Deliberately returns nothing
   * about the gate's state: this tool nudges, it does not decide, and a
   * platform that let it do more would be answering a question M32 already
   * answered.
   */
  notifyGateOwner(
    actingUser: string,
    args: { runId: string; step: string; message: string | null },
  ): Promise<{ runId: string; step: string; notified: string }>;
}
