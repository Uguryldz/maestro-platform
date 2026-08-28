-- HAND-WRITTEN MIGRATION.
--
-- `storage_blob` is the backing table of `@maestro/storage`'s `pg-blob` driver
-- (M5): the object store every non-S3 profile uses, and the one the `docx`/`pdf`
-- publish targets write the generated analysis document to (M103r).
--
-- Why it is hand-written rather than generated from `schema.prisma`: the table
-- does NOT belong to the Prisma schema and must not be added to it. Prisma owns
-- the workflow domain; this table is a driver's private storage, addressed only
-- through `StoragePort` and never through the Prisma client. Giving it a model
-- would publish `db.storageBlob.deleteMany()` to every caller in the monorepo —
-- an ORM-level bypass of the WORM protection the columns below exist to carry.
-- So it arrives the way `0002` arrives: as SQL Prisma cannot generate.
--
-- The DDL is NOT transcribed by hand. It is the exact output of
-- `pgBlobTableDdl()` (`packages/storage/src/pg.ts`), whose own doc comment says
-- it is "applied by the `db` packet's migration" — this file is that migration.
-- `test/storage-blob-migration.test.ts` re-derives the DDL from the function and
-- fails if the two ever drift, because a driver whose table is one column off
-- does not degrade: it throws on every put and the evidence goes missing.
--
-- Reversible: the whole migration is one table plus its index, so the down
-- direction is `DROP INDEX storage_blob_key_pattern_idx; DROP TABLE
-- storage_blob;`. Nothing is altered, so there is no existing-data hazard —
-- notably no NOT NULL column added to a populated table.
--
-- `IF NOT EXISTS` is deliberate and is what makes this safe to apply to a
-- deployment where an operator already created the table by hand from the same
-- function (the state the driver has been shipping in). Re-applying is a no-op
-- rather than a failed migration.

-- ---------------------------------------------------------------------------
-- The table the pg-blob driver reads and writes
-- ---------------------------------------------------------------------------
-- Column notes (all four WORM-relevant ones are load-bearing, M56/M57):
--
--   data bytea      the object itself; the driver writes a Buffer, because a
--                   bare Uint8Array would be serialised as JSON and silently
--                   corrupt the evidence.
--   tags jsonb      the retention policy tags derived from the key's class.
--   object_lock     WORM flag. Merged on conflict (OR), never replaced, so an
--                   ordinary put cannot clear a lock a previous put set.
--   retain_until    end of the retention window. Merged with GREATEST for the
--                   same reason. NULL is legal (an unlocked object) and is why
--                   this column is nullable — a NOT NULL here would make every
--                   ordinary put impossible.
--
-- Fail-closed is enforced in the DRIVER, not here: a put asking for a lock when
-- the deployment configured none is refused (`ObjectLockNotConfiguredError`).
-- The table deliberately does not default `object_lock` to true — a schema that
-- locked every row would make unlocked objects unwritable and hide the
-- misconfiguration this error exists to surface.

CREATE TABLE IF NOT EXISTS storage_blob (
  key text PRIMARY KEY,
  data bytea NOT NULL,
  content_type text NOT NULL,
  tags jsonb NOT NULL,
  object_lock boolean NOT NULL DEFAULT false,
  retain_until timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

-- `list` is a LIKE 'prefix%' scan; outside the C collation the primary key's
-- btree cannot serve it, so every listing would read the whole table.
CREATE INDEX IF NOT EXISTS storage_blob_key_pattern_idx
  ON storage_blob (key text_pattern_ops);
