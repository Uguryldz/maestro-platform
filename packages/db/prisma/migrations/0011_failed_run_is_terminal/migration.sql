-- A failed run is a finished run.
--
-- `WorkflowRun.status` was written by nothing outside the seeds: a row was
-- inserted `running` at intake and never moved again, because a run that
-- exhausts its Temporal retries dies INSIDE an activity and no workflow code
-- runs afterwards to write its epitaph. Measured on the pilot deployment:
-- 16 of 16 rows said `running` while the engine held 11 `Failed`, 1
-- `Completed` and 4 genuinely running. The dashboard read the rows literally
-- and told the operator that dead work was live.
--
-- The reconciler (`apps/deploy/src/stores/reconcile.ts`) now copies the
-- engine's verdict onto the row, which makes `fail` a status that actually
-- occurs — and that is what this migration has to catch up with.
--
-- The index below defines "live run" for the whole platform: it is what stops
-- a ticket having two simultaneous runs (M12/M46), and `TERMINAL_STATUSES` in
-- `apps/deploy/src/stores/run-context.ts` is the same set spelled in
-- TypeScript. Migration 0002 wrote that set as ('done','cancelled') at a time
-- when `fail` was unreachable, so the omission was invisible.
--
-- It stops being invisible the moment something writes `fail`. A failed run
-- that still counts as live keeps the ticket's one live slot occupied, and
-- that costs twice:
--
--   1. `PrismaRunContextStore.get` returns the newest NON-terminal run, so it
--      would keep handing activities the context of a run that is already
--      dead.
--   2. The next `/ai-start` on that ticket collides with this very index and
--      fails with P2002 — the ticket becomes permanently un-rerunnable, which
--      is the opposite of what noticing the failure was for.
--
-- So `fail` joins the terminal set. Re-running a failed ticket is a supported
-- operation; two simultaneously live runs still are not.
--
-- Recreated rather than altered: a partial index's WHERE clause is part of its
-- definition and Postgres has no ALTER for it. Both statements are in one
-- migration, so there is no window in which the uniqueness guarantee is absent.

DROP INDEX IF EXISTS "WorkflowRun_ticketKey_live_key";

CREATE UNIQUE INDEX "WorkflowRun_ticketKey_live_key"
  ON "WorkflowRun" ("ticketKey")
  WHERE "status" NOT IN ('done', 'cancelled', 'fail');
