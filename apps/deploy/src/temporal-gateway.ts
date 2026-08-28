import type {
  RunExecutionStatus,
  RunGateway,
  RunSummary,
  SignalOutcome,
  SignalWithStartInput,
  StartOutcome,
} from "@maestro/bff";
import { workflowIdFor } from "@maestro/bff";
import type { TicketKey, WorkflowRunState } from "@maestro/contracts";
import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
} from "@temporalio/client";
import { MAESTRO_TASK_QUEUE } from "@maestro/workflows";

/**
 * The BFF's `RunGateway`, backed by a real Temporal client.
 *
 * `apps/bff` declares this interface and never imports a Temporal package —
 * that is what keeps every BFF test offline (M44). Binding it to the engine is
 * composition-root work, so the implementation lives here.
 */

/** Temporal's status enum as the BFF's narrower vocabulary. */
const STATUS_BY_NAME: Readonly<Record<string, RunExecutionStatus>> = {
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  TERMINATED: "terminated",
  CONTINUED_AS_NEW: "continued_as_new",
  TIMED_OUT: "timed_out",
};

/**
 * The shape of a run id Temporal mints. Used to refuse anything else BEFORE it
 * reaches a visibility query — see `findByRunId`.
 */
export const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TemporalGatewayOptions {
  readonly client: Client;
  readonly taskQueue?: string;
  /** Workflow type name; must match what the worker registers. */
  readonly workflowType?: string;
  /**
   * Called after — and only after — a start actually created an execution.
   *
   * Every activity reads its run context back from the `WorkflowRun` row
   * (`RunContextStore`, packages/workflows/src/impl/deps.ts), so a started
   * execution with no row fails on its first activity with `RunNotFoundError`.
   * Something has to open that row, and this is the one place that knows a
   * start was real rather than a join onto a live run.
   *
   * It hangs off the gateway rather than off intake because the BFF must not
   * reach into Postgres: `apps/bff` depends on ports, not on `@maestro/db`
   * (M44). The composition root wires this to `PrismaRunContextStore.create`.
   *
   * Failures propagate. A run whose row was not written is a run that will
   * fail one activity later, further from the cause — reporting "started" for
   * it would be the silent kind of wrong.
   */
  readonly onRunOpened?: (run: OpenedRun) => Promise<void>;
}

/** What the gateway knows about a run at the moment Temporal accepted it. */
export interface OpenedRun {
  readonly runId: string;
  readonly ticket: string;
  /** `null` for an analysis-only start — intake sent no application at all. */
  readonly appId: string | null;
  readonly mode: SignalWithStartInput["mode"];
  readonly dataClass: SignalWithStartInput["dataClass"];
}

export class TemporalRunGateway implements RunGateway {
  private readonly client: Client;
  private readonly taskQueue: string;
  private readonly workflowType: string;
  private readonly onRunOpened: ((run: OpenedRun) => Promise<void>) | undefined;

  constructor(options: TemporalGatewayOptions) {
    this.client = options.client;
    this.taskQueue = options.taskQueue ?? MAESTRO_TASK_QUEUE;
    this.workflowType = options.workflowType ?? "ticketWorkflow";
    this.onRunOpened = options.onRunOpened;
  }

  /**
   * Open the run's row for a start that really started one.
   *
   * `started: false` means the caller joined a live execution, which already
   * has its row — calling again would be a second insert for one run.
   */
  private async openRun(input: SignalWithStartInput, outcome: StartOutcome): Promise<void> {
    if (!outcome.started || this.onRunOpened === undefined) return;
    await this.onRunOpened({
      runId: outcome.workflowId,
      ticket: input.ticket,
      appId: input.appId ?? null,
      mode: input.mode,
      dataClass: input.dataClass,
    });
  }

  /**
   * Readiness probe.
   *
   * `describeNamespace` on the deployment's OWN namespace, not a bare
   * connection check: a TCP connect proves only that something is listening,
   * and a client pointed at a namespace that does not exist would pass it
   * while every start and signal failed. The call is cheap and touches
   * precisely the thing the write paths need.
   */
  async ping(): Promise<void> {
    await this.client.connection.workflowService.describeNamespace({
      namespace: this.client.options.namespace,
    });
  }

  async list(options: { limit?: number; onlyRunning?: boolean } = {}): Promise<RunSummary[]> {
    const limit = options.limit ?? 50;
    const query =
      options.onlyRunning === true
        ? `WorkflowType='${this.workflowType}' AND ExecutionStatus='Running'`
        : `WorkflowType='${this.workflowType}'`;

    const summaries: RunSummary[] = [];
    for await (const execution of this.client.workflow.list({ query, pageSize: limit })) {
      const ticketKey = ticketOf(execution.workflowId);
      // An execution whose id this deployment did not mint is not ours to
      // report: the namespace may be shared, and a foreign workflow has no
      // ticket key to show a user.
      if (ticketKey === null) continue;
      summaries.push({
        workflowId: execution.workflowId,
        ticketKey: ticketKey as TicketKey,
        runId: execution.runId,
        status: STATUS_BY_NAME[execution.status.name] ?? "running",
        startedAt: execution.startTime.toISOString(),
        closedAt: execution.closeTime?.toISOString() ?? null,
      });
      if (summaries.length >= limit) break;
    }
    return summaries;
  }

  /**
   * Resolve a `runId` to its execution — an exact lookup, not a scan.
   *
   * `RunId='...'` is a visibility predicate the server evaluates, so the cost
   * and the correctness are independent of how many runs the namespace holds.
   * The BFF used to answer this by listing a page of recent runs and looking
   * through it, which quietly turned "which run is this" into "is this run
   * among the most recent 200".
   *
   * The workflow type is still part of the query and the id is still checked
   * against `ticketOf`, for the same reason `list` does it: the namespace may
   * be shared, and an execution this deployment did not mint has no ticket.
   */
  async findByRunId(runId: string): Promise<RunSummary | null> {
    // The id is interpolated into a visibility query and it arrives from an MCP
    // tool argument, so it is checked against the shape Temporal actually mints
    // — a UUID — rather than escaped. Anything else is not a run id this server
    // could have issued, so "no such run" is the honest answer and there is
    // nothing to quote. A caller must never be able to steer the predicate.
    if (!RUN_ID.test(runId)) return null;
    const query = `WorkflowType='${this.workflowType}' AND RunId='${runId}'`;
    for await (const execution of this.client.workflow.list({ query, pageSize: 1 })) {
      const ticketKey = ticketOf(execution.workflowId);
      if (ticketKey === null) return null;
      return {
        workflowId: execution.workflowId,
        ticketKey: ticketKey as TicketKey,
        runId: execution.runId,
        status: STATUS_BY_NAME[execution.status.name] ?? "running",
        startedAt: execution.startTime.toISOString(),
        closedAt: execution.closeTime?.toISOString() ?? null,
      };
    }
    return null;
  }

  /** `null` rather than a throw: "no such run" is an answer the UI renders. */
  async queryRunState(workflowId: string): Promise<WorkflowRunState | null> {
    try {
      return await this.client.workflow.getHandle(workflowId).query<WorkflowRunState>("runState");
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * Signal an EXISTING run, never create one. A gate decision for a ticket
   * Maestro is not running is a mistake to report, not a reason to invent a
   * workflow (M14) — hence `no_run` instead of a start.
   */
  async signal(workflowId: string, name: string, arg: unknown): Promise<SignalOutcome> {
    try {
      await this.client.workflow.getHandle(workflowId).signal(name, arg);
      return "delivered";
    } catch (error) {
      if (isNotFound(error)) return "no_run";
      throw error;
    }
  }

  /**
   * The intake path, atomic by construction.
   *
   * `signalWithStart` is what stops two webhook deliveries racing on one ticket
   * from producing two runs: the server resolves the race, not the BFF. The
   * `started` flag comes from whether the returned run id belonged to a fresh
   * execution — a caller that joined a live run must not be told it started one.
   */
  async signalWithStart(input: SignalWithStartInput): Promise<StartOutcome> {
    const workflowId = workflowIdFor(input.ticket);
    const args = [
      {
        ticket: input.ticket,
        // Omitted rather than sent as undefined for an analysis-only start:
        // absence is what the workflow reads as "no application", and the key
        // is spread here (not conditionally valued) so a start that HAS an app
        // serializes exactly the payload it always did.
        ...(input.appId === undefined ? {} : { appId: input.appId }),
        mode: input.mode,
        dataClass: input.dataClass,
        // Omitted rather than sent as null when nothing named a flow: the
        // workflow reads an absent `flow` as the full pipeline, and an
        // explicit null would mean the same thing while looking like a choice.
        ...(input.flow === undefined || input.flow === null ? {} : { flow: input.flow }),
        // Same treatment as `flow`, and the same reason: an absent status map
        // already means comment-only mode in the workflow, so sending an
        // explicit null would add a field that says nothing the omission does
        // not already say.
        ...(input.statusMap === undefined || input.statusMap === null
          ? {}
          : { statusMap: input.statusMap }),
      },
    ];
    const signal = input.signal;

    // A plain intake carries no signal, and `signalWithStart` has no "no
    // signal" mode — passing a name nothing handles would work only because
    // Temporal drops unknown signals silently, which is a behaviour to depend
    // on deliberately or not at all. `start` says what is meant, and its
    // already-started error is the same race resolution, reported honestly.
    if (signal === undefined) {
      try {
        await this.client.workflow.start(this.workflowType, {
          workflowId,
          taskQueue: this.taskQueue,
          args,
        });
        const outcome: StartOutcome = { workflowId, started: true };
        await this.openRun(input, outcome);
        return outcome;
      } catch (error) {
        if (error instanceof WorkflowExecutionAlreadyStartedError) {
          return { workflowId, started: false };
        }
        throw error;
      }
    }

    // With a signal, atomicity is the whole point: two deliveries racing on
    // one ticket must produce one run, and the server — not this process —
    // decides which of them created it.
    //
    // Whether this call was the creator is read from the run id that existed
    // BEFORE it. Temporal's signalWithStart reports the run it signalled but
    // not whether it had to create it, and asking again afterwards cannot
    // recover the difference: a joined run and a created one both answer with
    // the id the signal reached. Under a genuine race the pre-read can be
    // stale, so `started` is best-effort by construction — which is why no
    // caller may treat it as a lock. The atomicity that matters (one run per
    // ticket) comes from the server regardless of this flag.
    const before = await this.currentRunId(workflowId);
    const handle = await this.client.workflow.signalWithStart(this.workflowType, {
      workflowId,
      taskQueue: this.taskQueue,
      args,
      signal: signal.name,
      signalArgs: [...signal.args],
    });

    const outcome: StartOutcome = {
      workflowId,
      started: before === null || before !== handle.signaledRunId,
    };
    // `started` is best-effort here (see above), and `create` is written to
    // match: it re-checks for a live run and treats the unique violation as
    // success, so a false positive from a stale pre-read writes nothing.
    await this.openRun(input, outcome);
    return outcome;
  }

  /** Run id of the current execution, or `null` when there is none. */
  private async currentRunId(workflowId: string): Promise<string | null> {
    try {
      const description = await this.client.workflow.getHandle(workflowId).describe();
      return description.runId;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }
}

/** Inverse of `workflowIdFor`; `null` for ids this deployment did not mint. */
function ticketOf(workflowId: string): string | null {
  const prefix = "maestro-";
  return workflowId.startsWith(prefix) ? workflowId.slice(prefix.length) : null;
}

function isNotFound(error: unknown): boolean {
  return error instanceof WorkflowNotFoundError;
}

/** Connect to Temporal and build the gateway the BFF injects. */
export async function connectTemporal(options: {
  address: string;
  namespace?: string;
  taskQueue?: string;
  /** Forwarded to the gateway; see `TemporalGatewayOptions.onRunOpened`. */
  onRunOpened?: (run: OpenedRun) => Promise<void>;
}): Promise<{ gateway: TemporalRunGateway; close: () => Promise<void> }> {
  const connection = await Connection.connect({ address: options.address });
  const client = new Client({ connection, namespace: options.namespace ?? "default" });
  const gateway = new TemporalRunGateway({
    client,
    ...(options.taskQueue === undefined ? {} : { taskQueue: options.taskQueue }),
    ...(options.onRunOpened === undefined ? {} : { onRunOpened: options.onRunOpened }),
  });
  return { gateway, close: () => connection.close() };
}
