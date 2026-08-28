import type { RiskTier, StepId, WorkflowRunState, WorkMode } from "@maestro/contracts";
import type { RunRecord } from "@maestro/bff";
import { demoRunId } from "../fakes/run-gateway.js";

/**
 * The shape of a seeded run, and the two records one becomes.
 *
 * A run is TWO records in production: the platform's `RunRecord` (who reported
 * it, which app, what it cost) and the engine's `WorkflowRunState` (step,
 * status, risk). Studio reads both and joins them by ticket key. Deriving both
 * from ONE literal (`runs-data.ts`) is what keeps them from drifting: a catalog
 * row whose ticket has no execution renders as "a run that never started", and
 * a demo that produced that by accident would be teaching the reader a bug.
 */

export interface DemoRun {
  readonly ticketKey: string;
  readonly title: string;
  readonly appId: string | null;
  readonly mode: WorkMode;
  readonly risk: RiskTier;
  readonly step: StepId;
  readonly status: WorkflowRunState["status"];
  readonly reporter: string;
  readonly assignee: string | null;
  readonly parentTicketKey: string | null;
  readonly childTicketKeys: readonly string[];
  readonly prId: number | null;
  readonly costUsd: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** Hours before "now" the run started; the seed clock turns these into stamps. */
  readonly startedHoursAgo: number;
  readonly updatedHoursAgo: number;
}

/** ISO stamp `hours` before the seed instant. */
export function stampBefore(now: Date, hours: number): string {
  return new Date(now.getTime() - hours * 3_600_000).toISOString();
}

/** The catalog row Studio's ticket list and detail header read. */
export function runRecordOf(run: DemoRun, now: Date): RunRecord {
  return {
    ticketKey: run.ticketKey,
    title: run.title,
    appId: run.appId,
    mode: run.mode,
    risk: run.risk,
    // Payment and desktop work touches customer data; the rest is internal.
    dataClass: run.ticketKey.startsWith("UGURPAY") || run.ticketKey.startsWith("UGURDESK")
      ? "gizli"
      : "dahili",
    // The demo's catalog row and its engine state are derived from the SAME
    // `DemoRun`, so the two agree by construction — which is what makes the
    // demo a fair rehearsal of production, where they can disagree and the
    // route has to decide between them.
    status: run.status,
    parentTicketKey: run.parentTicketKey,
    childTicketKeys: run.childTicketKeys,
    reporter: run.reporter,
    assignee: run.assignee,
    prId: run.prId,
    costUsd: run.costUsd,
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
    startedAt: stampBefore(now, run.startedHoursAgo),
    updatedAt: stampBefore(now, run.updatedHoursAgo),
    // Every demo run is on the board (0019). A seeded archive would make the
    // demo open on a dashboard quietly missing rows the seed says it has —
    // the demo's job is to show the product working, and an archived row is
    // an operator's decision, not a starting condition.
    archivedAt: null,
  };
}

/** The engine's view of the same run — the half `GET /runs/:ticket` returns. */
export function runStateOf(run: DemoRun, now: Date): WorkflowRunState {
  return {
    runId: demoRunId(run.ticketKey),
    ticketKey: run.ticketKey,
    step: run.step,
    status: run.status,
    risk: run.risk,
    startedAt: stampBefore(now, run.startedHoursAgo),
    updatedAt: stampBefore(now, run.updatedHoursAgo),
  };
}
