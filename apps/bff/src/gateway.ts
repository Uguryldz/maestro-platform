import type {
  DataClass,
  FlowType,
  TicketKey,
  WorkMode,
  WorkflowRunState,
} from "@maestro/contracts";
import type { StatusMap } from "./listening-store.js";

/**
 * The workflow engine as the BFF sees it. Temporal lives behind this interface
 * so no route imports a client library, and so every test in this package runs
 * offline against a fake (M44 DI, insa-plani §2).
 */

/** One Temporal execution per ticket; the id is derived, never stored. */
export function workflowIdFor(ticket: TicketKey): string {
  return `maestro-${ticket}`;
}

/** Inverse of {@link workflowIdFor}; `null` for ids this deployment did not mint. */
export function ticketOfWorkflowId(workflowId: string): string | null {
  const prefix = "maestro-";
  return workflowId.startsWith(prefix) ? workflowId.slice(prefix.length) : null;
}

/** Closed-run outcomes Temporal reports, plus the one open state. */
export type RunExecutionStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "terminated"
  | "continued_as_new"
  | "timed_out";

export interface RunSummary {
  workflowId: string;
  ticketKey: TicketKey;
  runId: string;
  status: RunExecutionStatus;
  startedAt: string;
  closedAt: string | null;
}

export interface StartRunInput {
  ticket: TicketKey;
  /**
   * Absent for an analysis-only start: the binding named no application, and
   * intake only lets the `analiz` flow through that way (`runIntake` still
   * refuses `no_application` for every flow that writes code). The gateway
   * omits the field from the workflow input rather than sending a null, so
   * absence means the same thing on both sides of the wire.
   */
  appId?: string;
  mode: WorkMode;
  dataClass: DataClass;
  /**
   * Which phases the run should execute (`planFor`). A different axis from
   * `mode`: `mode` says how much the AI may decide alone, `flow` says which
   * steps run at all.
   *
   * Absent means the full pipeline — a ticket is never silently
   * under-processed because nothing named a flow.
   */
  flow?: FlowType | null;
  /**
   * Where the deciding listening rule wants the ticket to SIT on the board at
   * each point of the flow ("durum eşlemesi"). Absent or `null` is comment-only
   * mode — Maestro narrates in comments and never moves the ticket, which is
   * what every run did before the map existed.
   *
   * It travels beside `flow` and for the same reason: both are read off the
   * rule set once, on the way in, and PINNED into the start input. A workflow
   * cannot read the rules itself (M44), and a run that re-read them later could
   * finish under a rule it did not start under.
   */
  statusMap?: StatusMap | null;
}

export interface SignalWithStartInput extends StartRunInput {
  /**
   * Delivered to the run whether it had to be created or was already going.
   * Omitted for a plain intake, where the start itself is the whole event.
   */
  signal?: { name: string; args: readonly unknown[] };
}

export interface StartOutcome {
  workflowId: string;
  /** False when the call joined a run that was already going. */
  started: boolean;
}

/** `no_run` instead of a throw: "nobody is listening" is an answer, not a fault. */
export type SignalOutcome = "delivered" | "no_run";

export interface RunGateway {
  /** Cheap reachability probe for `/readyz`; throws when the engine is down. */
  ping(): Promise<void>;
  list(options?: { limit?: number; onlyRunning?: boolean }): Promise<RunSummary[]>;
  /** `null` when no execution exists for that id. */
  queryRunState(workflowId: string): Promise<WorkflowRunState | null>;
  /**
   * Resolve an execution's `runId` to the ticket that owns it, or `null`.
   *
   * `MaestroPlatform` is keyed by `runId` while every store here is keyed by
   * ticket, so something has to bridge the two. This method exists because the
   * obvious bridge — list a page of runs and look through it — is not a lookup
   * but a SEARCH, and a search has a horizon: the first implementation scanned
   * one 200-row page ordered by recency, so the 201st run in a caller's own
   * project answered "no such run" and could not be paused. A run id is an
   * exact key; resolving it must not depend on how recently the run was
   * touched or on how many runs the bank has.
   *
   * The engine is the right place for it because the engine minted the id.
   */
  findByRunId(runId: string): Promise<RunSummary | null>;
  /**
   * Signal an EXISTING run. Never creates one: a gate decision or a build
   * result for a ticket Maestro is not running is a mistake to report, not a
   * reason to invent a workflow (M14).
   */
  signal(workflowId: string, name: string, arg: unknown): Promise<SignalOutcome>;
  /**
   * Start-or-signal in one atomic call — the intake path. A ticket that has no
   * run gets one; a ticket that already has one just hears the signal, so two
   * webhook deliveries racing on the same ticket cannot produce two runs.
   */
  signalWithStart(input: SignalWithStartInput): Promise<StartOutcome>;
}
