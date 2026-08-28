import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pgBlobTableDdl } from "../src/pg.js";

/**
 * The drift guard between `pgBlobTableDdl()` and the migration that actually
 * creates the table in a deployment (`0017_storage_blob`).
 *
 * This exists because the two used to be unrelated: the function was called by
 * nothing but this package's own tests, and no migration created the table at
 * all. A fully finished analysis therefore attached NO document to its ticket,
 * failing with `relation "storage_blob" does not exist` — the driver was
 * configured, locked and correct, and wrote to a table that had never been
 * created.
 *
 * Reading the migration file rather than duplicating its text is the point: a
 * copy would be one more thing to keep in sync, and the failure mode of a table
 * one column off is not a degradation. `put` throws on every call, so the
 * evidence document silently goes missing at the end of a long analysis run.
 *
 * The file is read by path rather than through `@maestro/db` on purpose —
 * `db` does not depend on `storage` nor the reverse, and a whole package
 * dependency added for one assertion would couple two packages that have no
 * runtime relationship.
 */
const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../db/prisma/migrations/0017_storage_blob/migration.sql",
);

function readMigration(): string {
  return readFileSync(MIGRATION_PATH, "utf8");
}

/** The migration minus its `--` commentary, so prose cannot satisfy a check. */
function migrationStatements(): string {
  return readMigration()
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

describe("storage_blob migration (0017)", () => {
  it("exists where `prisma migrate deploy` will find it", () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
  });

  /**
   * The core assertion: every line the driver's own DDL emits is present in the
   * migration as an executable statement, not as a comment. Re-deriving from
   * the function means a column renamed in `pg.ts` fails here immediately.
   */
  it("carries the driver's DDL verbatim, so the table matches what the driver writes", () => {
    const sql = migrationStatements();
    for (const line of pgBlobTableDdl().split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      expect(sql, `missing from migration: ${trimmed}`).toContain(trimmed);
    }
  });

  it("creates every column the driver reads and writes", () => {
    const sql = migrationStatements();
    for (const column of [
      "key text PRIMARY KEY",
      "data bytea NOT NULL",
      "content_type text NOT NULL",
      "tags jsonb NOT NULL",
      "object_lock boolean NOT NULL DEFAULT false",
      "retain_until timestamptz",
      "created_at timestamptz NOT NULL",
      "updated_at timestamptz NOT NULL",
    ]) {
      expect(sql, column).toContain(column);
    }
  });

  /**
   * WORM (M56/M57) survives the schema. `retain_until` must stay NULLABLE:
   * an unlocked put writes NULL there, so a NOT NULL would make ordinary
   * puts impossible — and `object_lock` must not default to true for the
   * mirror-image reason.
   */
  it("keeps retain_until nullable, so an unlocked put is still writable", () => {
    expect(migrationStatements()).not.toMatch(/retain_until\s+timestamptz\s+NOT\s+NULL/i);
  });

  it("does not lock every row by default — fail-closed lives in the driver", () => {
    expect(migrationStatements()).not.toMatch(/object_lock\s+boolean\s+NOT\s+NULL\s+DEFAULT\s+true/i);
  });

  it("indexes the key for the prefix scan `list` performs", () => {
    // Without text_pattern_ops a LIKE 'prefix%' cannot use the index outside
    // the C collation, and every listing degrades to a full table scan.
    expect(migrationStatements()).toContain("text_pattern_ops");
  });

  /**
   * Re-applying must be a no-op, not a failed migration: some deployments
   * already have the table, created by hand from this same function.
   */
  it("is safe to apply twice", () => {
    const sql = migrationStatements();
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS storage_blob");
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS storage_blob_key_pattern_idx");
  });

  /** A first-creation migration only creates; a DROP here would destroy evidence. */
  it("destroys nothing", () => {
    expect(migrationStatements()).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX)\b/i);
  });
});
