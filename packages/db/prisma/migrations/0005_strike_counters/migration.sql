-- Dalga 6: the three-strike counter, made durable (M54).
--
-- `StrikeLedger` counted in a `Map`, which is correct for one worker process
-- that never stops. Neither holds in this deployment: a worker is redeployed
-- mid-run, and Temporal can retry an activity on a DIFFERENT worker from the
-- one that recorded strike two. Both cases reset the count to zero, so "the
-- same failure three times" never arrives and the run retries the same failing
-- turn forever — the exact stuck loop M54 exists to break.
--
-- Extended by hand with the CHECK at the bottom; Prisma has no syntax for it,
-- and it is the kind of invariant that must hold for every client rather than
-- only for well-behaved code (same reasoning as 0002 and 0004).

-- ---------------------------------------------------------------------------
-- StrikeCounter
-- ---------------------------------------------------------------------------
-- The primary key is the counting rule itself: different scopes never share a
-- count, so a green build does not absolve three rejections at the Tech Lead
-- gate. `(runId, scope, ref)` is what keeps those separate, and it is what the
-- ledger's upsert conflicts on.
CREATE TABLE "StrikeCounter" (
    "runId" VARCHAR(128) NOT NULL,
    "scope" VARCHAR(16) NOT NULL,
    "ref" VARCHAR(256) NOT NULL,
    "count" INTEGER NOT NULL,
    "firstAt" TIMESTAMPTZ(3) NOT NULL,
    "lastAt" TIMESTAMPTZ(3) NOT NULL,
    "reasons" TEXT[],

    CONSTRAINT "StrikeCounter_pkey" PRIMARY KEY ("runId","scope","ref")
);

-- "which counters does this run have" — the ledger reads them all back in one
-- query before the turn starts, which is what makes the count survive.
CREATE INDEX "StrikeCounter_runId_idx" ON "StrikeCounter"("runId");

-- ON DELETE RESTRICT, like every other relation in this schema (M30/M56).
-- A counter that reached its limit is the reason a ticket went to a human, so
-- it is evidence of how the run was handled rather than scratch state; a
-- cascade would let a deletion elsewhere quietly take that record with it. The
-- ledger clears counters explicitly when they stop applying.
ALTER TABLE "StrikeCounter" ADD CONSTRAINT "StrikeCounter_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "WorkflowRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The scope vocabulary, enforced by the database.
--
-- `STRIKE_SCOPES` is a TypeScript union, which constrains this process and
-- nothing else. A row written by a migration, a fixture or a future service
-- with a fourth scope would hydrate as `agent` (the ledger's fail-safe) and
-- silently merge two different counters into one. Refusing the write is the
-- narrower failure.
ALTER TABLE "StrikeCounter" ADD CONSTRAINT "StrikeCounter_scope_check"
    CHECK ("scope" IN ('gate', 'ci', 'agent'));

-- A counter exists because something failed at least once; zero or negative
-- would make `count >= limit` answerable by a row that records no failure.
ALTER TABLE "StrikeCounter" ADD CONSTRAINT "StrikeCounter_count_check"
    CHECK ("count" >= 1);
