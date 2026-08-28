import type { GateDecision, StepId, WorkflowRunState } from "@maestro/contracts";
import { APPROVAL_GATE_STEPS, STEP_IDS } from "@maestro/contracts";
import type {
  RunGateway,
  RunSummary,
  SignalOutcome,
  SignalWithStartInput,
  StartOutcome,
} from "@maestro/bff";
import { ticketOfWorkflowId, workflowIdFor } from "@maestro/bff";

/**
 * The workflow engine, in memory.
 *
 * Temporal is not running in the demo, but the engine's OBSERVABLE behaviour is
 * not faked away: a signal that reaches an open gate actually closes it and
 * moves the run to the next step, and a signal for a workflow that does not
 * exist still answers `no_run`. That distinction is the whole reason this class
 * is not a stub returning `"delivered"` — if approving a gate in Studio left the
 * run exactly where it was, the demo would be showing a button that does
 * nothing while claiming success.
 *
 * What it deliberately does NOT do is run the 19 steps: no activity executes, no
 * agent session opens, nothing is built. It advances the STATE MACHINE, which is
 * the part Studio reads. Every other step transition would need a worker.
 */
export class InMemoryRunGateway implements RunGateway {
  private readonly states = new Map<string, WorkflowRunState>();

  /** Every signal delivered, in order — the demo's proof that something happened. */
  readonly delivered: Array<{ workflowId: string; name: string; arg: unknown; at: string }> = [];

  constructor(
    states: readonly WorkflowRunState[] = [],
    private readonly clock: { now(): Date } = { now: () => new Date() },
  ) {
    for (const state of states) this.put(state);
  }

  put(state: WorkflowRunState): void {
    this.states.set(workflowIdFor(state.ticketKey), { ...state });
  }

  /** The run as it stands now — what the tests assert a signal changed. */
  stateOf(ticketKey: string): WorkflowRunState | null {
    return this.states.get(workflowIdFor(ticketKey)) ?? null;
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  list(options?: { limit?: number; onlyRunning?: boolean }): Promise<RunSummary[]> {
    const rows = [...this.states.values()]
      .filter((state) => options?.onlyRunning !== true || isOpen(state.status))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map<RunSummary>((state) => ({
        workflowId: workflowIdFor(state.ticketKey),
        ticketKey: state.ticketKey,
        runId: state.runId,
        status: executionStatusOf(state),
        startedAt: state.startedAt,
        closedAt: isOpen(state.status) ? null : state.updatedAt,
      }));
    return Promise.resolve(options?.limit === undefined ? rows : rows.slice(0, options.limit));
  }

  queryRunState(workflowId: string): Promise<WorkflowRunState | null> {
    const state = this.states.get(workflowId);
    return Promise.resolve(state === undefined ? null : { ...state });
  }

  /**
   * Resolve a run id to its run — an exact lookup, not a search.
   *
   * Temporal answers this with a visibility query on `RunId=`; here the map is
   * small enough to walk. What matters is that it walks ALL of it: the real
   * gateway's first implementation scanned one page of recent runs, so a run
   * that had not been touched lately answered "no such run" and could not be
   * paused. A demo that reproduced that horizon would hide the same bug.
   */
  findByRunId(runId: string): Promise<RunSummary | null> {
    for (const [workflowId, state] of this.states) {
      if (state.runId !== runId) continue;
      return Promise.resolve({
        workflowId,
        ticketKey: state.ticketKey,
        runId: state.runId,
        status: executionStatusOf(state),
        startedAt: state.startedAt,
        closedAt: isOpen(state.status) ? null : state.updatedAt,
      });
    }
    return Promise.resolve(null);
  }

  /**
   * Deliver a signal to an EXISTING run, and apply the state change the workflow
   * would have applied. Never creates a run: a decision for a ticket nobody is
   * running is a mistake to report, not a reason to invent a workflow.
   */
  signal(workflowId: string, name: string, arg: unknown): Promise<SignalOutcome> {
    const state = this.states.get(workflowId);
    if (state === undefined) return Promise.resolve("no_run");

    const at = this.clock.now().toISOString();
    this.delivered.push({ workflowId, name, arg, at });
    this.states.set(workflowId, { ...applySignal(state, name, arg), updatedAt: at });
    return Promise.resolve("delivered");
  }

  signalWithStart(input: SignalWithStartInput): Promise<StartOutcome> {
    const workflowId = workflowIdFor(input.ticket);
    const existed = this.states.has(workflowId);
    const at = this.clock.now().toISOString();

    if (!existed) {
      this.states.set(workflowId, {
        runId: demoRunId(input.ticket),
        ticketKey: input.ticket,
        step: "0",
        status: "running",
        startedAt: at,
        updatedAt: at,
      });
    }
    if (input.signal !== undefined) {
      void this.signal(workflowId, input.signal.name, input.signal.args[0]);
    }
    return Promise.resolve({ workflowId, started: !existed });
  }
}

/**
 * The run id for a seeded ticket. Derived rather than random so the journal, the
 * evidence package and the run all key off the same string — a seed whose
 * journal belongs to a different run id is exactly the inconsistency the demo is
 * supposed to be free of (`seed.test.ts` asserts it).
 *
 * `RunId` demands 8+ chars from a constrained alphabet, so the ticket key is
 * lower-cased and its dash kept (both legal) behind a fixed prefix.
 */
export function demoRunId(ticketKey: string): string {
  return `run-${ticketKey.toLowerCase()}`;
}

/** Open runs have no close time; the rest are finished one way or another. */
function isOpen(status: WorkflowRunState["status"]): boolean {
  return status !== "done" && status !== "cancelled";
}

/**
 * `WorkflowRunStatus` (what the delivery is doing) mapped onto
 * `RunExecutionStatus` (what Temporal would say about the execution). The two
 * vocabularies are deliberately different — a run sitting at a gate is a
 * `running` execution — and collapsing them would misreport the fleet.
 */
function executionStatusOf(state: WorkflowRunState): RunSummary["status"] {
  if (state.status === "done") return "completed";
  if (state.status === "cancelled") return "cancelled";
  return "running";
}

/**
 * What a signal does to the run.
 *
 * Only the transitions the demo can honestly claim are implemented. An approved
 * gate advances to the next step and starts running; a rejected one goes back to
 * engineering (6a), which is what the workflow does with changes-requested. A
 * mode change records nothing about progress, so the run is left where it is —
 * silently pretending a mode change advanced the flow would be a lie.
 */
function applySignal(state: WorkflowRunState, name: string, arg: unknown): WorkflowRunState {
  if (name === "gateDecision") {
    const decision = arg as Partial<GateDecision> | null;
    if (state.status !== "gate") return state;
    if (decision?.decision === "reject") return { ...state, step: "6a", status: "running" };
    if (decision?.decision === "approve") {
      const next = stepAfter(state.step);
      return next === null
        ? { ...state, step: "13", status: "done" }
        : { ...state, step: next, status: nextStatusAt(next) };
    }
    return state;
  }

  // The clarification wait (2b) is the one non-approval gate a human closes.
  if (name === "clarificationAnswered" && state.step === "2b") {
    return { ...state, step: "3o", status: "running" };
  }

  return state;
}

/** The next step in the canonical order, or `null` at the end of the flow. */
function stepAfter(step: StepId): StepId | null {
  const index = STEP_IDS.indexOf(step);
  if (index < 0 || index + 1 >= STEP_IDS.length) return null;
  return STEP_IDS[index + 1] ?? null;
}

/** A run that lands on another approval gate waits there rather than running. */
function nextStatusAt(step: StepId): WorkflowRunState["status"] {
  if (step === "13") return "done";
  return (APPROVAL_GATE_STEPS as readonly StepId[]).includes(step) ? "gate" : "running";
}

export { ticketOfWorkflowId, workflowIdFor };
