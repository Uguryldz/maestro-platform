import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/index.js";
import { allMigrationSql, readGuardsMigration, readMigration } from "./paths.js";

/**
 * Behavioural proof of migration `0002`: the guards are only real if a client
 * that tries to break them actually fails.
 *
 * This file needs a live, throwaway Postgres, so it is opt-in:
 *
 *   docker run -d --rm -p 55432:5432 -e POSTGRES_PASSWORD=maestro \
 *     -e POSTGRES_DB=maestro_test --name maestro-pg postgres:16-alpine
 *   TEST_DATABASE_URL=postgresql://postgres:maestro@localhost:55432/maestro_test \
 *     pnpm -F @maestro/db test
 *
 * The rest of the suite stays offline (the wave gate runs without a database),
 * and the same assertions are made against the migration *text* in
 * `test/migration.test.ts`, so a deleted trigger fails the offline suite too.
 */
const url = process.env["TEST_DATABASE_URL"];

/**
 * Split a migration into statements. `;` inside a `$$ … $$` dollar-quoted body
 * (the plpgsql trigger function) is not a statement boundary — splitting naively
 * would cut the function in half and the guard would silently not be installed.
 */
export function splitSqlStatements(sql: string): string[] {
  // Comments go first: a prose `;` inside a `--` line would otherwise look like
  // a statement boundary and cut the comment in half.
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
  return statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0);
}

describe("splitSqlStatements", () => {
  it("keeps a dollar-quoted function body in one piece", () => {
    const parts = splitSqlStatements(
      `CREATE FUNCTION f() RETURNS trigger AS $$\nBEGIN\n  RAISE EXCEPTION 'x';\nEND;\n$$ LANGUAGE plpgsql;\nSELECT 1;`,
    );
    expect(parts.length).toBe(2);
    expect(parts[0]).toContain("RAISE EXCEPTION");
    expect(parts[1]).toBe("SELECT 1");
  });

  it("drops comment lines before looking for a boundary, prose semicolons included", () => {
    const parts = splitSqlStatements(`-- one thing; another thing\nSELECT 1;\n-- trailing\n`);
    expect(parts).toEqual(["SELECT 1"]);
  });
});

describe.skipIf(url === undefined || url.trim().length === 0)("database guards (live)", () => {
  let db: Db;

  beforeAll(async () => {
    db = createDb(url as string, { log: ["error"] });
    await db.$executeRawUnsafe("DROP SCHEMA IF EXISTS public CASCADE");
    await db.$executeRawUnsafe("CREATE SCHEMA public");
    for (const sql of [readMigration(), readGuardsMigration()]) {
      for (const statement of splitSqlStatements(sql)) {
        await db.$executeRawUnsafe(statement);
      }
    }
    await db.$executeRawUnsafe(
      `INSERT INTO "WorkflowRun" ("id","ticketKey","mode","dataClass","step","status","startedAt","updatedAt")
       VALUES ('run-live-1','LIVE-1','full_auto','dahili','3','running', now(), now())`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "JournalEntry" ("runId","seq","at","actor","kind","title","detail")
       VALUES ('run-live-1', 0, now(), 'system', 'intake', 'first', '')`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "AuditLog" ("seq","at","actor","action","subject","prevHash","hash")
       VALUES (1, now(), 'maestro-worker', 'RUN_STARTED', 'LIVE-1', 'genesis', '${"a".repeat(64)}')`,
    );
  }, 120_000);

  afterAll(async () => {
    await db?.$disconnect();
  });

  it("refuses an UPDATE on the journal", async () => {
    await expect(
      db.$executeRawUnsafe(`UPDATE "JournalEntry" SET "title" = 'rewritten' WHERE "seq" = 0`),
    ).rejects.toThrow(/append-only/);
  });

  it("refuses a DELETE on the journal", async () => {
    await expect(
      db.$executeRawUnsafe(`DELETE FROM "JournalEntry" WHERE "seq" = 0`),
    ).rejects.toThrow(/append-only/);
  });

  it("refuses an UPDATE on the audit log", async () => {
    await expect(
      db.$executeRawUnsafe(`UPDATE "AuditLog" SET "actor" = 'mallory' WHERE "seq" = 1`),
    ).rejects.toThrow(/append-only/);
  });

  it("refuses a DELETE and a TRUNCATE on the audit log", async () => {
    await expect(db.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "seq" = 1`)).rejects.toThrow(
      /append-only/,
    );
    await expect(db.$executeRawUnsafe(`TRUNCATE "AuditLog"`)).rejects.toThrow(/append-only/);
  });

  it("refuses a second record pointing at the same predecessor (no forked chain)", async () => {
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "AuditLog" ("seq","at","actor","action","subject","prevHash","hash")
         VALUES (2, now(), 'maestro-worker', 'RUN_CLOSED', 'LIVE-1', 'genesis', '${"b".repeat(64)}')`,
      ),
    ).rejects.toThrow(/\("prevHash"\)=\(genesis\) already exists/);
  });

  it("refuses a guarded parameter version with no approver (four eyes)", async () => {
    await db.$executeRawUnsafe(
      `INSERT INTO "Param" ("key","scope","type","guarded","defJson")
       VALUES ('merge.mode','project','enum', true, '{}'::jsonb)`,
    );
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "ParamVersion" ("key","scopeRef","version","valueJson","guarded","changedBy","at")
         VALUES ('merge.mode','',1,'"auto_merge"'::jsonb, true, 'ugur@corp', now())`,
      ),
    ).rejects.toThrow(/ParamVersion_guarded_needs_approver/);

    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "ParamVersion" ("key","scopeRef","version","valueJson","guarded","changedBy","approvedBy","at")
         VALUES ('merge.mode','',1,'"auto_merge"'::jsonb, true, 'ugur@corp', 'mert@corp', now())`,
      ),
    ).resolves.toBe(1);
  });

  it("allows a ticket to be re-run, but never two live runs at once", async () => {
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "WorkflowRun" ("id","ticketKey","mode","dataClass","step","status","startedAt","updatedAt")
         VALUES ('run-live-2','LIVE-1','full_auto','dahili','0','running', now(), now())`,
      ),
    ).rejects.toThrow(/\("ticketKey"\)=\(LIVE-1\) already exists/);

    // Cancel the first run, and the ticket may start over.
    await db.$executeRawUnsafe(`UPDATE "WorkflowRun" SET "status" = 'cancelled' WHERE "id" = 'run-live-1'`);
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "WorkflowRun" ("id","ticketKey","mode","dataClass","step","status","startedAt","updatedAt")
         VALUES ('run-live-2','LIVE-1','full_auto','dahili','0','running', now(), now())`,
      ),
    ).resolves.toBe(1);
  });
});

/**
 * Behavioural proof of migration `0008` (Dalga E): the durable-store guards are
 * only real if a client that tries to break them fails. Same opt-in switch and
 * same offline-text mirror (`test/migration.test.ts`) as the block above.
 *
 * A fresh schema loading ALL migrations, so `Session` and `KillSwitch` exist —
 * they arrive in 0008, which the block above deliberately does not load.
 */
describe.skipIf(url === undefined || url.trim().length === 0)("durable-store guards (live)", () => {
  let db: Db;

  beforeAll(async () => {
    db = createDb(url as string, { log: ["error"] });
    await db.$executeRawUnsafe("DROP SCHEMA IF EXISTS public CASCADE");
    await db.$executeRawUnsafe("CREATE SCHEMA public");
    for (const statement of splitSqlStatements(allMigrationSql())) {
      await db.$executeRawUnsafe(statement);
    }
  }, 120_000);

  afterAll(async () => {
    await db?.$disconnect();
  });

  it("refuses a session that expires before it was issued", async () => {
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "Session" ("token","userId","username","rolesJson","groupsJson","issuedAt","expiresAt")
         VALUES ('t1','ugur@corp','ugur','[]'::jsonb,'[]'::jsonb, now(), now() - interval '1 hour')`,
      ),
    ).rejects.toThrow(/Session_expiry_after_issue/);
  });

  it("allows exactly one kill-switch row and refuses a second (M58)", async () => {
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "KillSwitch" ("id","level","actor","reason","at")
         VALUES ('ONLY','all','ugur@corp','incident', now())`,
      ),
    ).resolves.toBe(1);
    // A second row with a different id is refused by the single-row CHECK.
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "KillSwitch" ("id","level","actor","reason","at")
         VALUES ('OTHER','off','mert@corp','none', now())`,
      ),
    ).rejects.toThrow(/KillSwitch_single_row/);
  });

  it("refuses a kill-switch level the platform cannot read — a brake must never fail open", async () => {
    await expect(
      db.$executeRawUnsafe(
        `UPDATE "KillSwitch" SET "level" = 'paused' WHERE "id" = 'ONLY'`,
      ),
    ).rejects.toThrow(/KillSwitch_level_valid/);
  });
});
