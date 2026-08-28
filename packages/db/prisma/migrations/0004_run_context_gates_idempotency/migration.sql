-- Dalga 5: the run-scoped stores the worker refuses to start without.
--
-- Generated with `prisma migrate diff` against the 0001..0003 database, then
-- extended by hand with the two CHECK constraints at the bottom — Prisma has no
-- syntax for either, and both are the kind of invariant that must hold for
-- every client rather than only for well-behaved code (same reasoning as 0002).
--
-- What it adds:
--   1. WorkflowRun     — the RunContext columns (branch, workspace, pins, …)
--   2. Gate            — approval gates + escalation ladder state (M88)
--   3. IdempotencyKey  — cross-process idempotency (M33)
--   4. PublishState    — the publisher's receipt memory (M47/M75)

-- ---------------------------------------------------------------------------
-- 1. RunContext columns on the run row
-- ---------------------------------------------------------------------------
-- Activities receive a TicketKey and nothing else, so every fact about a run is
-- read back from this row. NOT NULL with a default rather than nullable: an
-- existing run predates these columns and must still read back, and a caller
-- that forgets to set `branch` should get "" — which the store refuses loudly —
-- rather than NULL, which every reader would have to remember to check.
ALTER TABLE "WorkflowRun" ADD COLUMN     "branch" VARCHAR(255) NOT NULL DEFAULT '',
ADD COLUMN     "locale" VARCHAR(8) NOT NULL DEFAULT 'tr',
ADD COLUMN     "prId" INTEGER,
ADD COLUMN     "protectedPathsJson" JSONB,
ADD COLUMN     "resumeToken" TEXT,
ADD COLUMN     "targetBranch" VARCHAR(255) NOT NULL DEFAULT '',
ADD COLUMN     "templateVersion" VARCHAR(64) NOT NULL DEFAULT '',
ADD COLUMN     "variantId" VARCHAR(64) NOT NULL DEFAULT '',
ADD COLUMN     "verificationJson" JSONB,
ADD COLUMN     "workspacePath" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "workspacePresent" BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- 2. Gate (M88)
-- ---------------------------------------------------------------------------
-- The primary key is the idempotency of `GateStore.open`: re-opening an open
-- gate cannot mint a second row, so `openedAt` — the escalation ladder's anchor
-- — cannot be moved by a duplicate signal, and the ladder cannot restart.
CREATE TABLE "Gate" (
    "runId" VARCHAR(128) NOT NULL,
    "step" VARCHAR(8) NOT NULL,
    "ownerGroup" VARCHAR(128) NOT NULL,
    "openedAt" TIMESTAMPTZ(3) NOT NULL,
    "firedStepIds" TEXT[],
    "closedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Gate_pkey" PRIMARY KEY ("runId","step")
);

-- ---------------------------------------------------------------------------
-- 3. IdempotencyKey (M33)
-- ---------------------------------------------------------------------------
-- One row per effect. Two workers retrying the same activity both INSERT;
-- exactly one wins the primary key, and the loser replays the winner's result
-- instead of running the effect twice.
CREATE TABLE "IdempotencyKey" (
    "key" VARCHAR(512) NOT NULL,
    "state" VARCHAR(16) NOT NULL,
    "resultJson" JSONB,
    "claimedAt" TIMESTAMPTZ(3) NOT NULL,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("key")
);

-- ---------------------------------------------------------------------------
-- 4. PublishState (M47/M75)
-- ---------------------------------------------------------------------------
-- The publisher's memory of what it already posted. Without it a republish
-- adds a SECOND Jira comment instead of editing the first, every time.
CREATE TABLE "PublishState" (
    "key" VARCHAR(512) NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PublishState_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "Gate_closedAt_idx" ON "Gate"("closedAt");

-- CreateIndex
CREATE INDEX "IdempotencyKey_claimedAt_idx" ON "IdempotencyKey"("claimedAt");

-- AddForeignKey
ALTER TABLE "Gate" ADD CONSTRAINT "Gate_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkflowRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- HAND-WRITTEN from here down (Prisma cannot express either constraint).
-- ---------------------------------------------------------------------------

-- A gate cannot close before it opened. Time going backwards on a gate is how
-- an escalation ladder computes a negative age and fires every step at once,
-- and how an evidence package reports an approval that precedes the request.
ALTER TABLE "Gate"
  ADD CONSTRAINT "Gate_closed_after_opened"
  CHECK ("closedAt" IS NULL OR "closedAt" >= "openedAt");

-- `state` is a two-value domain kept as text (adding an enum type for it would
-- make every future state a migration). The CHECK is what stops it from
-- becoming free text: a row in an unknown state is one the guard cannot reason
-- about, and it would either replay a result that was never computed or re-run
-- an effect that already happened.
--
-- The second clause is the one that matters: a `done` row must carry the
-- instant it completed. Without it a crashed claim could be read as a finished
-- one and its (absent) result replayed as if it were the real answer.
ALTER TABLE "IdempotencyKey"
  ADD CONSTRAINT "IdempotencyKey_state_valid"
  CHECK (
    ("state" = 'running' AND "completedAt" IS NULL)
    OR ("state" = 'done' AND "completedAt" IS NOT NULL)
  );
