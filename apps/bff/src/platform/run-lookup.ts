import type { WorkflowRunState } from "@maestro/contracts";
import type { ResolvedDeps, SessionRecord } from "../deps.js";
import { notFound } from "../errors.js";
import { workflowIdFor } from "../gateway.js";
import { projectKeyOf } from "../jira-intake.js";
import { canSeeProject } from "../routes/access.js";

/**
 * Turning a `runId` into a record the caller is allowed to have.
 *
 * Its own module because it is the one place two keyspaces meet:
 * `MaestroPlatform` is keyed by run id and every store here is keyed by ticket.
 * Seven methods depend on it, so a mistake in it is a mistake in all seven —
 * which is exactly what happened.
 */

/**
 * Why the refusal is deliberately ambiguous.
 *
 * "No such run" and "not your project" have to be indistinguishable, or the
 * error becomes a way to probe which run ids exist: a caller could sweep ids
 * and learn which ones were real from the difference between 403 and 404.
 *
 * That ambiguity is a security property, but on its own it misleads. An
 * operator looking at a run in Studio and getting `no_run` from a tool concludes
 * the run was deleted and goes looking for the wrong problem. The note says
 * which TWO things the code means without saying which one happened — the
 * ambiguity is preserved, the false certainty is not.
 */
export const NO_RUN_NOTE = "no such run, or not in a project you can see";

export type ResolvedRun = {
  record: NonNullable<Awaited<ReturnType<ResolvedDeps["read"]["runs"]["get"]>>>;
  state: WorkflowRunState;
};

/**
 * Resolve a run id to its record, refusing one the caller may not see.
 *
 * The lookup goes through the engine, which minted the id: one exact
 * `findByRunId`, then that ticket's catalog row. It used to scan a single page
 * of recent runs instead — `PLATFORM_MAX_LIMIT` rows ordered by recency — which
 * quietly made the page's horizon a correctness boundary. Past it, a caller's
 * OWN run answered "no such run": it could not be read, paused, resumed or
 * retried, and an admin had no more luck than anyone else. Two hundred runs is
 * a small number for a bank's SDLC, so this was reachable rather than
 * theoretical, and the symptom pointed at the wrong diagnosis.
 *
 * The project check still happens before anything is returned. A cheaper lookup
 * that skipped it would have traded a horizon bug for an authorisation one.
 */
export async function runOf(
  deps: ResolvedDeps,
  session: SessionRecord,
  runId: string,
): Promise<ResolvedRun> {
  const summary = await deps.runs.findByRunId(runId);
  if (summary !== null && canSeeProject(session, projectKeyOf(summary.ticketKey))) {
    const record = await deps.read.runs.get(summary.ticketKey);
    const state = await deps.runs.queryRunState(workflowIdFor(summary.ticketKey));
    // The state's own run id is re-checked rather than trusted from the
    // summary: the two come from different calls, and a workflow that was
    // continued-as-new between them would otherwise resolve to a sibling
    // execution the caller did not ask about.
    if (record !== null && state !== null && state.runId === runId) {
      return { record, state };
    }
  }
  throw notFound("no_run", { runId, note: NO_RUN_NOTE });
}
