import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, type Db } from "@maestro/db";
import { createPgBlobStorage } from "@maestro/storage";
import type { StoragePort } from "@maestro/ports";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaSqlExecutor } from "../src/stores/sql.js";

/**
 * End-to-end proof that migration `0017_storage_blob` gives the pg-blob driver
 * a table it can actually use — through the REAL driver and the REAL Prisma
 * adapter the worker composes, not a fake.
 *
 * This is the regression test for a failure that reached a live ticket: the
 * analysis ran to completion, both gates were approved, and the Jira issue got
 * ZERO attachments because `put` failed with
 *
 *   relation "storage_blob" does not exist
 *
 * `pgBlobTableDdl()` existed and was correct; nothing applied it. The offline
 * mirror of these assertions is `packages/storage/test/pg-migration.test.ts`,
 * so a deleted migration fails the gate even without a database.
 *
 * Opt-in, exactly like `live-stores.test.ts`:
 *
 *   docker run -d --rm -p 55432:5432 -e POSTGRES_PASSWORD=maestro \
 *     -e POSTGRES_DB=maestro_test --name maestro-pg postgres:18-alpine
 *   TEST_DATABASE_URL=postgresql://postgres:maestro@localhost:55432/maestro_test \
 *     pnpm -F @maestro/deploy test
 */
const url = process.env["TEST_DATABASE_URL"];
const live = url === undefined || url.trim().length === 0 ? describe.skip : describe;

const MIGRATIONS_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/prisma/migrations",
);

/** Every migration's SQL in order — the deployment's own starting state. */
function allMigrationSql(): string {
  return readdirSync(MIGRATIONS_ROOT)
    .filter((entry) => /^\d+_/.test(entry))
    .sort()
    .map((entry) => readFileSync(join(MIGRATIONS_ROOT, entry, "migration.sql"), "utf8"))
    .join("\n");
}

/**
 * Split on `;`, honouring `$$ … $$` bodies (0002's trigger function) and
 * dropping comment lines so a prose semicolon is not a statement boundary.
 */
function splitSqlStatements(sql: string): string[] {
  const withoutComments = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  const statements: string[] = [];
  let current = "";
  let inDollarQuote = false;
  for (let i = 0; i < withoutComments.length; i++) {
    if (withoutComments.startsWith("$$", i)) {
      inDollarQuote = !inDollarQuote;
      current += "$$";
      i += 1;
      continue;
    }
    const char = withoutComments[i] ?? "";
    if (char === ";" && !inDollarQuote) {
      statements.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  statements.push(current);
  return statements.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * A minimal but REAL .docx: a zip whose first bytes are the `PK\x03\x04` local
 * file header every Office reader checks. Bytes matter here — the bug this
 * file guards against corrupts binaries silently, so a text fixture would not
 * exercise the `bytea`/Buffer path that actually broke.
 */
const DOCX_BYTES = new Uint8Array([
  0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0x08, 0x00, 0x00, 0x00, 0x21, 0x00, 0xde, 0xad,
  0xbe, 0xef, 0x00, 0x01, 0x02, 0xfd, 0xfe, 0xff,
]);

const DOCX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

live("storage_blob after migration 0017 (live)", () => {
  let db: Db;
  let storage: StoragePort;
  /** The same driver WITHOUT objectLock, to prove the fail-closed path. */
  let unconfigured: StoragePort;

  beforeAll(async () => {
    db = createDb(url as string, { log: ["error"] });
    await db.$executeRawUnsafe("DROP SCHEMA IF EXISTS public CASCADE");
    await db.$executeRawUnsafe("CREATE SCHEMA public");
    for (const statement of splitSqlStatements(allMigrationSql())) {
      await db.$executeRawUnsafe(statement);
    }
    const sql = prismaSqlExecutor(db);
    storage = createPgBlobStorage(
      { table: "storage_blob", objectLock: { mode: "COMPLIANCE", years: 10 } },
      { sql },
    );
    unconfigured = createPgBlobStorage({ table: "storage_blob" }, { sql });
  }, 120_000);

  afterAll(async () => {
    await db?.$disconnect();
  });

  it("creates the table the driver was already configured to write to", async () => {
    const rows = await db.$queryRawUnsafe<{ table_name: string }[]>(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'storage_blob'",
    );
    expect(rows).toHaveLength(1);
  });

  it("writes a real .docx and reads back the identical bytes", async () => {
    const key = "evidence/OPS-51/analiz.docx";
    await storage.put(key, DOCX_BYTES, { contentType: DOCX_CONTENT_TYPE, objectLock: true });

    const read = await storage.get(key);
    // Byte-for-byte, not merely "same length": the failure this guards against
    // (Uint8Array serialised as JSON) produces plausible-looking garbage.
    expect(Array.from(read)).toEqual(Array.from(DOCX_BYTES));
    expect(Array.from(read.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it("stores the content type and lists the document under its prefix", async () => {
    const rows = await db.$queryRawUnsafe<{ content_type: string }[]>(
      "SELECT content_type FROM storage_blob WHERE key = 'evidence/OPS-51/analiz.docx'",
    );
    expect(rows[0]?.content_type).toBe(DOCX_CONTENT_TYPE);
    await expect(storage.list("evidence/OPS-51/")).resolves.toContain(
      "evidence/OPS-51/analiz.docx",
    );
  });

  it("locks the document: the row carries a retention the driver can enforce", async () => {
    const rows = await db.$queryRawUnsafe<{ object_lock: boolean; retain_until: Date | null }[]>(
      "SELECT object_lock, retain_until FROM storage_blob WHERE key = 'evidence/OPS-51/analiz.docx'",
    );
    expect(rows[0]?.object_lock).toBe(true);
    const retainUntil = rows[0]?.retain_until;
    expect(retainUntil).toBeInstanceOf(Date);
    // Ten years out, give or take leap days — the point is that it is far in
    // the future, not that it lands on an exact instant.
    const years = ((retainUntil as Date).getTime() - Date.now()) / (365.25 * 24 * 3600 * 1000);
    expect(years).toBeGreaterThan(9.5);
  });

  it("refuses to overwrite or delete the retained document (WORM, M57)", async () => {
    const key = "evidence/OPS-51/analiz.docx";
    await expect(storage.put(key, new Uint8Array([0x00]))).rejects.toThrow(/locked|retain/i);
    await expect(storage.delete(key)).rejects.toThrow(/locked|retain/i);

    // And the original bytes are still there afterwards.
    await expect(storage.get(key)).resolves.toHaveLength(DOCX_BYTES.length);
  });

  it("still writes ordinary unlocked objects — retain_until stays NULL", async () => {
    await storage.put("scratch/note.txt", new Uint8Array([0x68, 0x69]));
    const rows = await db.$queryRawUnsafe<{ object_lock: boolean; retain_until: Date | null }[]>(
      "SELECT object_lock, retain_until FROM storage_blob WHERE key = 'scratch/note.txt'",
    );
    expect(rows[0]?.object_lock).toBe(false);
    expect(rows[0]?.retain_until).toBeNull();
    await expect(storage.delete("scratch/note.txt")).resolves.toBeUndefined();
  });

  /**
   * Fail-closed survives the migration: the table does NOT make a lock
   * possible where the deployment configured none. A driver without
   * `objectLock` must refuse a locked put rather than quietly downgrade it.
   */
  it("refuses a locked put when the deployment configured no lock", async () => {
    await expect(
      unconfigured.put("evidence/OPS-99/analiz.docx", DOCX_BYTES, { objectLock: true }),
    ).rejects.toThrow(/lock/i);
    // Nothing was written by the refused call.
    const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(
      "SELECT count(*)::bigint AS n FROM storage_blob WHERE key = 'evidence/OPS-99/analiz.docx'",
    );
    expect(Number(rows[0]?.n ?? 0)).toBe(0);
  });

  it("is idempotent: applying the migration twice changes nothing", async () => {
    const ddl = readFileSync(
      join(MIGRATIONS_ROOT, "0017_storage_blob", "migration.sql"),
      "utf8",
    );
    for (const statement of splitSqlStatements(ddl)) {
      await expect(db.$executeRawUnsafe(statement)).resolves.toBeDefined();
    }
    // The locked document survived the re-apply.
    await expect(storage.get("evidence/OPS-51/analiz.docx")).resolves.toHaveLength(
      DOCX_BYTES.length,
    );
  });
});
