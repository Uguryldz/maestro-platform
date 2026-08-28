-- HAND-WRITTEN MIGRATION.
--
-- Jira durum eşlemesi: a listening rule may OPTIONALLY carry the statuses the
-- ticket should be moved to as its flow progresses. Until now Maestro was
-- comment-only — it narrated progress in Jira comments and never touched the
-- board — because moving someone else's ticket without being told to is the
-- kind of surprise that gets an automation switched off. This column is how an
-- operator says "yes, drive my board", per rule.
--
-- NULLable, and NULL is the meaning-bearing default: no map = comment-only =
-- exactly today's behaviour. That is what makes this migration purely additive
-- against the live table — every existing row (the OPS/Görev/analiz rule
-- included) keeps working untouched, with no backfill and no DEFAULT to write
-- over millions of pages. A non-null map opts that ONE rule into transition
-- mode; a rule that maps only the points it cares about (say `onDone` alone)
-- leaves the others alone.
--
-- jsonb rather than five VARCHAR columns: the set of flow points is a product
-- decision that has already moved once (0015 added the variant pair) and will
-- move again, and a column per point makes every new point another ALTER
-- against a table a running pilot is reading. The shape is validated in the
-- BFF write path (Zod, `.strict()`), which is the only producer — the database
-- deliberately carries no CHECK on the document's keys, because a CHECK on a
-- json shape would turn tomorrow's added key into a failed write on a live
-- system rather than a schema decision made deliberately here.
--
-- Values are STATUS NAMES ('Devam Ediyor', 'İNCELEMEDE', …), never Jira
-- transition ids: ids are per-workflow, so a rule copied to a second project
-- would silently drive the wrong transitions, while a name is the same string
-- the operator reads on their own board.
--
-- Reversible: one added nullable column, so the down direction is
-- `ALTER TABLE "ListeningRule" DROP COLUMN "statusMapJson";`. Nothing is
-- rewritten and no NOT NULL is added to a populated table, so there is no
-- existing-data hazard and no table rewrite — Postgres records a nullable add
-- as a catalog-only change.
--
-- `IF NOT EXISTS` is deliberate: migrations 0008-0016 were half-applied on this
-- deployment historically, so a migration here must be safe to re-apply against
-- a database that already has the column. Re-applying is a no-op rather than a
-- failed migration that blocks every later one.

ALTER TABLE "ListeningRule" ADD COLUMN IF NOT EXISTS "statusMapJson" JSONB;

COMMENT ON COLUMN "ListeningRule"."statusMapJson" IS
  'Optional Jira status map (onStart/onNeedInfo/onReview/onRejected/onDone, reassignOnNeedInfo). NULL = comment-only mode: Maestro never moves the ticket.';
