import type { WorkflowRunStatus } from "@maestro/contracts";
import type { AuditChain } from "@maestro/audit";
import type { RunExecutionStatus, RunSummary } from "@maestro/bff";
import { WORKER_ACTOR } from "@maestro/workflows";

/**
 * Reconcile `WorkflowRun.status` with what the engine actually did.
 *
 * A run row is written `running` at intake and, until this file existed,
 * NOTHING ever moved it again. The dashboard read those rows literally and
 * reported dead work as live: measured on the pilot deployment, 16 of 16 rows
 * said `running` while Temporal held 11 `Failed`, 1 `Completed` and only 4
 * genuinely running. An operator watching that panel sees a working system.
 *
 * Why a reconciler and not the workflow itself: a run that exhausts its retries
 * dies INSIDE an activity (`RETRY_STATE_MAXIMUM_ATTEMPTS_REACHED`). No workflow
 * code runs afterwards, so the run cannot write its own epitaph — and a final
 * "mark me failed" activity would travel the same broken path that just failed.
 * Something outside the run has to do it, which is this.
 *
 * The engine is the source of truth and the database is the copy. That
 * direction is the whole design: this file never invents a status, it only
 * copies one Temporal already decided.
 */

/** The columns a reconcile pass may write. Status and nothing else. */
export interface RunStatusUpdate {
  status: WorkflowRunStatus;
}

/**
 * The `WorkflowRun` reach this pass needs, named method by method — the same
 * structural-delegate pattern `RunContextStore` uses, and for the same reason:
 * it is a written-down statement of exactly how much of the table this touches.
 */
export interface ReconcileDelegate {
  findMany(args: {
    where: { status: { notIn: WorkflowRunStatus[] } };
    select: { id: true; ticketKey: true; status: true };
  }): Promise<Array<{ id: string; ticketKey: string; status: string }>>;
  updateMany(args: {
    where: { id: string; status: { notIn: WorkflowRunStatus[] } };
    data: RunStatusUpdate;
  }): Promise<{ count: number }>;
}

/** Just the slice of `RunGateway` a reconcile pass reads. */
export interface ReconcileSource {
  list(options?: { limit?: number; onlyRunning?: boolean }): Promise<RunSummary[]>;
}

export interface ReconcileDeps {
  readonly runs: ReconcileDelegate;
  readonly source: ReconcileSource;
  readonly audit: AuditChain;
  /** How many executions to ask the engine for. Defaults to 500. */
  readonly limit?: number;
}

export interface ReconcileReport {
  /** Rows whose status this pass moved. */
  readonly reconciled: number;
  /** Rows left alone because the engine still calls them live. */
  readonly stillRunning: number;
  /**
   * Rows the engine said nothing about. Deliberately untouched — see
   * {@link reconcileRunStatuses}.
   */
  readonly unknown: number;
}

/**
 * Which DB status a closed execution becomes.
 *
 * `terminated` and `timed_out` both land on `fail` rather than `cancelled`:
 * `cancelled` in this schema means a human stopped the work deliberately, and
 * recording an infrastructure timeout as a human decision would put a
 * conclusion in the audit trail that nobody reached.
 *
 * `running` and `continued_as_new` are absent on purpose. Both mean the run is
 * still going, and the absence is what makes {@link reconcileRunStatuses} leave
 * their rows alone instead of having to special-case them.
 */
const DB_STATUS_BY_EXECUTION: Partial<Record<RunExecutionStatus, WorkflowRunStatus>> = {
  completed: "done",
  failed: "fail",
  cancelled: "cancelled",
  terminated: "fail",
  timed_out: "fail",
};

/**
 * Statuses a reconcile pass will never overwrite.
 *
 * These are the three the WORKFLOW writes about itself while it is alive, and
 * they carry information Temporal's execution status does not have: a run
 * parked at `gate` is `Running` to the engine, and flattening it to `running`
 * would erase the fact that a human is being waited on. A reconcile pass only
 * ever moves a row from "engine says live" to "engine says closed".
 */
const RECONCILE_PROTECTED = ["gate", "queued", "handover"] as const;

/**
 * Terminal statuses, mirrored from the store.
 *
 * Not imported from `run-context.ts` because that constant answers a different
 * question ("which run does a ticket mean") and is narrower by design. This one
 * answers "which rows has a reconcile pass already settled", and it must
 * include every status this file can WRITE — otherwise the second pass would
 * rewrite what the first one wrote and the guard below would not hold.
 */
const SETTLED = ["done", "cancelled", "fail"] as const;

/** Rows this pass may consider at all: not settled, not workflow-owned. */
const SKIP: WorkflowRunStatus[] = [...SETTLED, ...RECONCILE_PROTECTED];

/**
 * Copy the engine's verdict onto every run row that has one.
 *
 * IDEMPOTENT, and it has to be: the worker runs this at every boot, and a
 * crash-loop would otherwise append an audit record per restart. Two things
 * enforce it. The read skips rows already settled, so a second pass finds
 * nothing to do; and the write is a conditional `updateMany` carrying the same
 * `notIn` filter, so a row settled by a concurrent pass between this pass's
 * read and its write updates zero rows. `count === 0` is the signal that
 * somebody else got there first, and the audit record is written only when
 * this pass is the one that actually moved the row.
 *
 * FAIL-CLOSED. A row the engine says nothing about is LEFT `running`. That is
 * the deliberately wrong-looking choice: those rows are the ones whose truth is
 * unknown — retention may have dropped the execution, or the namespace may have
 * been rebuilt — and `running` is the status that keeps a human looking at it.
 * Marking an unknown run `done` would retire it from every dashboard and hide
 * any gate still waiting on it, which is the one outcome worse than a stale
 * `running`.
 */
export async function reconcileRunStatuses(deps: ReconcileDeps): Promise<ReconcileReport> {
  const open = await deps.runs.findMany({
    where: { status: { notIn: SKIP } },
    select: { id: true, ticketKey: true, status: true },
  });
  if (open.length === 0) return { reconciled: 0, stillRunning: 0, unknown: 0 };

  const executions = await deps.source.list({ limit: deps.limit ?? 500, onlyRunning: false });
  // Keyed by ticket: the row's id IS the workflow id today (`maestro-<ticket>`),
  // but that equality is the BFF's to define, and keying on the ticket both
  // sides already agree on survives it changing.
  const byTicket = new Map<string, RunSummary>();
  for (const execution of executions) {
    const seen = byTicket.get(execution.ticketKey);
    // Newest wins: a re-run leaves several executions on one ticket, and the
    // row a reconcile pass is settling is the current one.
    if (seen === undefined || execution.startedAt > seen.startedAt) {
      byTicket.set(execution.ticketKey, execution);
    }
  }

  let reconciled = 0;
  let stillRunning = 0;
  let unknown = 0;

  for (const row of open) {
    const execution = byTicket.get(row.ticketKey);
    if (execution === undefined) {
      unknown += 1;
      continue;
    }
    const next = DB_STATUS_BY_EXECUTION[execution.status];
    if (next === undefined) {
      stillRunning += 1;
      continue;
    }
    const moved = await settle(deps, row.id, next, execution);
    if (moved) reconciled += 1;
  }

  return { reconciled, stillRunning, unknown };
}

/**
 * Write one row's status and record it, or do neither.
 *
 * The audit record is written only after a `count` of 1 proves this pass is the
 * one that moved the row. Writing it first — or unconditionally — would let two
 * workers booting together append two `RUN_CLOSED` records for one closure, and
 * an audit chain that double-counts is worse than one that is late.
 */
async function settle(
  deps: ReconcileDeps,
  id: string,
  status: WorkflowRunStatus,
  execution: RunSummary,
): Promise<boolean> {
  const result = await deps.runs.updateMany({
    where: { id, status: { notIn: SKIP } },
    data: { status },
  });
  if (result.count === 0) return false;

  await deps.audit.append({
    actor: WORKER_ACTOR,
    action: "RUN_CLOSED",
    subject: execution.ticketKey,
    // `at` is the engine's close time, not now: this record describes when the
    // run ENDED, which may be hours before the boot that noticed it.
    ...(execution.closedAt === null ? {} : { at: execution.closedAt }),
    meta: {
      runId: id,
      status,
      source: "temporal",
      executionStatus: execution.status,
      temporalRunId: execution.runId,
      reconciled: true,
    },
  });
  return true;
}
