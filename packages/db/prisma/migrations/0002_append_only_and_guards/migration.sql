-- HAND-WRITTEN MIGRATION (the only one).
--
-- Everything Prisma can express lives in 0001_init, which is generated with
-- `pnpm -F @maestro/db migration:build` and must never be edited by hand.
-- The four objects below have no Prisma syntax, so they cannot be generated:
--
--   1. row-level triggers          (append-only enforcement)
--   2. CHECK constraints           (four-eyes on guarded parameters)
--   3. partial UNIQUE indexes      (at most one LIVE run per ticket)
--
-- Rationale is in packages/db/RAPOR.md §2b. Guarded by test/migration.test.ts.

-- ---------------------------------------------------------------------------
-- 1. Append-only: JournalEntry (M30) and AuditLog (M33)
-- ---------------------------------------------------------------------------
-- The journal is the raw material of the evidence package and the audit log is
-- a hash chain; "we only insert" was a convention enforced by every caller,
-- which means it was enforced by none. A row-level trigger makes UPDATE and
-- DELETE impossible for every client — psql, a migration, a stray Prisma
-- `deleteMany`, an ORM in a future package — not only for well-behaved code.
--
-- TRUNCATE is a statement-level operation and needs its own trigger; without it
-- `TRUNCATE "AuditLog"` would empty an "append-only" table without firing a
-- single row trigger.

CREATE OR REPLACE FUNCTION maestro_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'maestro_append_only: %.% is append-only, % is refused (M30/M33)',
    TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "JournalEntry_append_only"
  BEFORE UPDATE OR DELETE ON "JournalEntry"
  FOR EACH ROW EXECUTE FUNCTION maestro_append_only();

CREATE TRIGGER "JournalEntry_append_only_truncate"
  BEFORE TRUNCATE ON "JournalEntry"
  FOR EACH STATEMENT EXECUTE FUNCTION maestro_append_only();

CREATE TRIGGER "AuditLog_append_only"
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION maestro_append_only();

CREATE TRIGGER "AuditLog_append_only_truncate"
  BEFORE TRUNCATE ON "AuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION maestro_append_only();

-- ---------------------------------------------------------------------------
-- 2. Four-eyes on guarded parameters (M71 / M78 pattern)
-- ---------------------------------------------------------------------------
-- `ParamVersion.guarded` is a denormalized copy of `Param.guarded` (a CHECK may
-- not contain a sub-query). With it, a guarded parameter version without a
-- second approver is rejected by the database, not merely by the service that
-- happens to be writing.

ALTER TABLE "ParamVersion"
  ADD CONSTRAINT "ParamVersion_guarded_needs_approver"
  CHECK (NOT "guarded" OR "approvedBy" IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 3. At most one live run per ticket (M12/M46)
-- ---------------------------------------------------------------------------
-- `WorkflowRun.ticketKey` used to be UNIQUE, which locked a ticket to a single
-- run for its whole life: after a kill switch, a handover or a cancellation a
-- second `/ai-start` on the same ticket failed with P2002. Re-running is a
-- supported operation; two *simultaneously live* runs are not.

CREATE UNIQUE INDEX "WorkflowRun_ticketKey_live_key"
  ON "WorkflowRun" ("ticketKey")
  WHERE "status" NOT IN ('done', 'cancelled');
