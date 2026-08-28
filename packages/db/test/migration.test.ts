import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseEnums, parseModels } from "../src/index.js";
import {
  GUARDS_MIGRATION_PATH,
  MIGRATION_LOCK_PATH,
  MIGRATION_PATH,
  allMigrationSql,
  readGuardsMigration,
  readMigration,
  readMigrationNamed,
  readSchema,
} from "./paths.js";

/**
 * `0001_init` is generated offline with
 * `prisma migrate diff --from-empty --to-schema-datamodel ... --script`
 * (`pnpm -F @maestro/db migration:build`) and is never edited by hand. These
 * tests are the guard that the committed SQL still covers the committed schema
 * — a model added without regenerating fails here instead of at deploy time.
 *
 * `0002_append_only_and_guards` is the one hand-written migration: triggers,
 * CHECK constraints and partial unique indexes have no Prisma syntax, so they
 * cannot be generated. It is tested by content here and, when a database is
 * available, by behaviour in `test/live-guards.test.ts`.
 */
const schema = readSchema();
const sql = readMigration();
const guards = readGuardsMigration();

describe("initial migration", () => {
  it("exists next to a provider lock file", () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
    expect(readFileSync(MIGRATION_LOCK_PATH, "utf8")).toContain('provider = "postgresql"');
  });

  /**
   * Reads the WHOLE migration set, not only 0001 — the same reasoning the enum
   * test below already follows. A model added in a later migration is history,
   * not drift: `Gate`, `IdempotencyKey` and `PublishState` arrive in 0004, and
   * a guard that only looked at the initial migration would demand they be
   * back-dated into a generated file that must never be edited by hand.
   *
   * What the guard still catches is the thing it exists for: a model in the
   * schema that NO migration creates, which is a table the deployment will not
   * have.
   */
  it("creates a table for every model", () => {
    const allSql = allMigrationSql();
    const missing = parseModels(schema)
      .map((m) => m.tableName)
      .filter((table) => !allSql.includes(`CREATE TABLE "${table}" (`));
    expect(missing).toEqual([]);
  });

  it("creates a type for every enum", () => {
    const missing = parseEnums(schema)
      .map((e) => e.name)
      .filter((name) => !sql.includes(`CREATE TYPE "${name}" AS ENUM`));
    expect(missing).toEqual([]);
  });

  // Reads the WHOLE migration set, not just 0001: an enum value added later
  // arrives through `ALTER TYPE ... ADD VALUE`, and a guard that only looked at
  // the initial migration would call it drift.
  it("carries every enum value into the migrated types", () => {
    const allSql = allMigrationSql();
    for (const parsed of parseEnums(schema)) {
      const created = allSql
        .split("\n")
        .find((l) => l.startsWith(`CREATE TYPE "${parsed.name}" AS ENUM`));
      expect(created, `no CREATE TYPE for ${parsed.name}`).toBeDefined();
      for (const value of parsed.values) {
        const inCreate = created?.includes(`'${value}'`) ?? false;
        const added = allSql.includes(`ALTER TYPE "${parsed.name}" ADD VALUE '${value}'`);
        expect(inCreate || added, `${parsed.name}.${value} never reaches the database`).toBe(true);
      }
    }
  });

  it("wires the foreign keys as RESTRICT", () => {
    const fks = sql.split("\n").filter((l) => l.includes("FOREIGN KEY"));
    expect(fks.length).toBe(6);
    for (const fk of fks) {
      expect(fk).toContain("ON DELETE RESTRICT");
    }
  });

  it("does not make an org-wide routing rule point at a binding (B-1)", () => {
    expect(sql).not.toMatch(/"RoutingRule".*FOREIGN KEY/);
    expect(sql).toMatch(/"projectKey" VARCHAR\(32\),/); // nullable: NULL = org-wide
  });

  it("declares timestamptz columns, not naive timestamps", () => {
    expect(sql).toContain("TIMESTAMPTZ(3)");
    expect(sql).not.toMatch(/TIMESTAMP\(3\)/);
  });

  it("is destructive-statement free (a first migration only creates)", () => {
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|TYPE)\b/i);
  });

  it("makes the audit chain unforkable at the index level (M33)", () => {
    expect(sql).toContain('CREATE UNIQUE INDEX "AuditLog_prevHash_key" ON "AuditLog"("prevHash")');
    expect(sql).toContain('CREATE UNIQUE INDEX "AuditLog_hash_key" ON "AuditLog"("hash")');
  });

  it("stops locking a ticket to one run for its lifetime (B-12)", () => {
    expect(sql).not.toContain('CREATE UNIQUE INDEX "WorkflowRun_ticketKey_key"');
    expect(sql).not.toContain('CREATE UNIQUE INDEX "EvidencePackageRow_ticketKey_key"');
    expect(sql).toContain('CREATE INDEX "WorkflowRun_ticketKey_idx"');
  });

  it("keys knowledge documents by (id, version) so a pin survives (M83)", () => {
    expect(sql).toContain('CONSTRAINT "KnowledgeDoc_pkey" PRIMARY KEY ("id","version")');
  });
});

describe("append-only + guard migration (hand-written, 0002)", () => {
  it("exists and says so", () => {
    expect(existsSync(GUARDS_MIGRATION_PATH)).toBe(true);
    expect(guards).toContain("HAND-WRITTEN MIGRATION");
  });

  it("refuses UPDATE, DELETE and TRUNCATE on both append-only tables", () => {
    expect(guards).toMatch(/CREATE OR REPLACE FUNCTION maestro_append_only\(\)/);
    expect(guards).toContain("RAISE EXCEPTION");
    for (const table of ["JournalEntry", "AuditLog"]) {
      expect(guards, table).toMatch(
        new RegExp(`BEFORE UPDATE OR DELETE ON "${table}"[\\s\\S]*?maestro_append_only`),
      );
      expect(guards, table).toMatch(
        new RegExp(`BEFORE TRUNCATE ON "${table}"[\\s\\S]*?maestro_append_only`),
      );
    }
  });

  it("makes four-eyes a database constraint, not a convention (M71)", () => {
    expect(guards).toMatch(
      /CHECK \(NOT "guarded" OR "approvedBy" IS NOT NULL\)/,
    );
  });

  it("allows a ticket to be re-run but never twice at once (M12/M46)", () => {
    expect(guards).toMatch(
      /CREATE UNIQUE INDEX "WorkflowRun_ticketKey_live_key"[\s\S]*?WHERE "status" NOT IN \('done', 'cancelled'\)/,
    );
  });

  it("adds nothing Prisma could have generated itself", () => {
    expect(guards).not.toMatch(/^\s*CREATE TABLE/im);
    expect(guards).not.toMatch(/^\s*CREATE TYPE/im);
  });
});

describe("listening-rule Jira status map (hand-written, 0018)", () => {
  const sql = allMigrationSql();
  const migration = readMigrationNamed("0018_listening_rule_status_map");
  /**
   * The EXECUTABLE half, with `--` comment lines removed. The prose in this
   * migration names the down direction ("DROP COLUMN …") on purpose, and a
   * guard that read the comments would either fail on that or push the author
   * into deleting the most useful sentence in the file to keep the test green.
   * What must be free of destructive statements is the SQL, not the reasoning.
   */
  const statements = migration
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("adds the column as NULLABLE jsonb — NULL is comment-only mode", () => {
    // Nullable is the whole safety argument: NULL means "do not move tickets",
    // which is what every pre-0018 row already did, so no row needs a backfill
    // and no running pilot changes behaviour on deploy.
    expect(sql).toMatch(
      /ALTER TABLE "ListeningRule" ADD COLUMN IF NOT EXISTS "statusMapJson" JSONB;/,
    );
    expect(sql).not.toMatch(/"statusMapJson"\s+JSONB\s+NOT NULL/i);
    expect(sql).not.toMatch(/"statusMapJson"\s+JSONB\s+DEFAULT/i);
  });

  it("only ADDS — it never drops or rewrites a table a live pilot is reading", () => {
    expect(migration).toContain("HAND-WRITTEN MIGRATION");
    expect(statements).not.toMatch(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT)\b/i);
    expect(statements).not.toMatch(/\b(UPDATE|DELETE FROM|TRUNCATE)\b/i);
    // One table only: 0018 must not reach into anything else on a live system.
    const touched = [...statements.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1]);
    expect([...new Set(touched)]).toEqual(["ListeningRule"]);
  });

  it("stores status NAMES, not transition ids, and says why", () => {
    // Load-bearing enough to pin: transition ids are per-workflow, so a rule
    // copied to a second project would drive the wrong transitions silently.
    expect(migration).toMatch(/STATUS NAMES/);
    expect(migration).toMatch(/never Jira\s+-- transition ids/);
  });

  it("keeps the schema and the migration agreeing that the column is optional", () => {
    // The pair that actually protects the live table: a `Json` (not `Json?`) in
    // the schema would make Prisma demand a value on every write against rows
    // the migration deliberately left NULL.
    expect(schema).toMatch(/statusMapJson\s+Json\?/);
  });
});

describe("run archiving (hand-written, 0019)", () => {
  const sql = allMigrationSql();
  const migration = readMigrationNamed("0019_workflow_run_archived_at");
  /**
   * The EXECUTABLE half, `--` comment lines removed — the same split 0018 makes
   * and for the same reason: this migration's prose names its own down
   * direction ("DROP COLUMN …") and explains that archiving is not a DELETE,
   * and a guard reading the comments would either fail on those words or push
   * the author into deleting the most useful sentences in the file to keep the
   * suite green. What must be free of destructive statements is the SQL.
   */
  const statements = migration
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("adds the column as NULLABLE — NULL is 'still on the board'", () => {
    // Nullable is the entire safety argument: NULL is what every pre-0019 row
    // already means, so no row needs a backfill, no DEFAULT rewrites a table
    // the pilot is reading, and no operator's dashboard changes on deploy.
    expect(sql).toMatch(
      /ALTER TABLE "WorkflowRun" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMPTZ\(3\);/,
    );
    expect(sql).not.toMatch(/"archivedAt"\s+TIMESTAMPTZ\(3\)\s+NOT NULL/i);
    expect(sql).not.toMatch(/"archivedAt"\s+TIMESTAMPTZ\(3\)\s+DEFAULT/i);
  });

  /**
   * The assertion this whole feature rests on: archiving must never become
   * deleting. A bank keeps its audit trail, and a `WorkflowRun` is pointed at
   * by its journal, its step events and its evidence package — so a migration
   * that removed rows here would take the evidence with it.
   */
  it("only ADDS — it never drops, updates or deletes a row of live history", () => {
    expect(migration).toContain("HAND-WRITTEN MIGRATION");
    expect(statements).not.toMatch(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT)\b/i);
    expect(statements).not.toMatch(/\b(UPDATE|DELETE FROM|TRUNCATE)\b/i);
  });

  it("touches exactly one table, so a live deployment risks nothing else", () => {
    const touched = [...statements.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1]);
    expect([...new Set(touched)]).toEqual(["WorkflowRun"]);
  });

  it("is re-appliable, because 0008-0016 were half-applied on this deployment", () => {
    // Without `IF NOT EXISTS` a re-run is a failed migration that blocks every
    // later one — the specific hazard this deployment's history creates.
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS");
  });

  it("declares timestamptz, not a naive timestamp", () => {
    // Same rule 0001 is held to: an operator in Istanbul and a server in UTC
    // must agree on when a run left the board.
    expect(statements).toMatch(/TIMESTAMPTZ\(3\)/);
    expect(statements).not.toMatch(/\bTIMESTAMP\(3\)/);
  });

  it("keeps the schema and the migration agreeing that the column is optional", () => {
    // The pair that protects the live table: a `DateTime` (not `DateTime?`) in
    // the schema would make Prisma demand a value on every write against rows
    // the migration deliberately left NULL — and every existing row is NULL.
    expect(schema).toMatch(/archivedAt\s+DateTime\?\s+@db\.Timestamptz\(3\)/);
  });

  it("says in the file itself that archiving is not deleting", () => {
    // Load-bearing prose: the next person to read this migration has to learn
    // that the row survives, or the feature grows a DELETE the day someone
    // wants the board tidier still.
    expect(migration).toMatch(/DELETE/);
    expect(migration).toMatch(/audit trail/i);
  });
});

describe("durable sessions + kill switch (hand-written, 0008)", () => {
  const sql = allMigrationSql();

  it("creates both tables", () => {
    expect(sql).toContain('CREATE TABLE "Session" (');
    expect(sql).toContain('CREATE TABLE "KillSwitch" (');
  });

  it("keys a session by its token, so a lookup is one indexed read", () => {
    expect(sql).toContain('CONSTRAINT "Session_pkey" PRIMARY KEY ("token")');
  });

  it("indexes sessions by user and expiry — logout acts on the account, the sweep on the clock", () => {
    expect(sql).toContain('CREATE INDEX "Session_userId_idx" ON "Session"("userId")');
    expect(sql).toContain('CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt")');
  });

  it("refuses a session that expires before it was issued", () => {
    expect(sql).toMatch(/"Session_expiry_after_issue" CHECK \("expiresAt" > "issuedAt"\)/);
  });

  it("makes the kill switch a single row, not the newest of several (M58)", () => {
    // The whole point of the durable table: `get()` reads ONE row, never a
    // "latest by timestamp" a clock skew could answer wrong.
    expect(sql).toMatch(/"KillSwitch_single_row" CHECK \("id" = 'ONLY'\)/);
  });

  it("refuses a kill-switch level the platform cannot read — a brake must never fail open", () => {
    expect(sql).toMatch(
      /"KillSwitch_level_valid" CHECK \("level" IN \('off', 'intake_only', 'all'\)\)/,
    );
  });
});

describe("listening-rule catch-all matchKind (hand-written, 0020)", () => {
  const sql = allMigrationSql();
  const migration = readMigrationNamed("0020_listening_rule_match_kind_assigned");
  /**
   * The EXECUTABLE half, `--` comment lines removed — the same split 0018 and
   * 0019 make. This migration's prose spells out its own down direction and
   * explains why a nullable `matchValue` was rejected, so a guard reading the
   * comments would fail on words that are the most useful thing in the file.
   */
  const statements = migration
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("widens the closed domain to three members, keeping the original two", () => {
    // The whole change. Dropping either of the first two would orphan every
    // rule on this deployment, so the new list is asserted verbatim rather
    // than by "contains 'assigned'".
    expect(statements).toMatch(
      /ADD CONSTRAINT "ListeningRule_matchKind_domain"\s+CHECK \("matchKind" IN \('status', 'issuetype', 'assigned'\)\);/,
    );
  });

  it("keeps matchKind a CLOSED domain — widening is not opening", () => {
    // A migration that simply removed the CHECK would also make `assigned`
    // work, and would let a typo like "assinged" through to a matcher that
    // silently classifies nothing. The constraint has to come back.
    const drops = [...statements.matchAll(/DROP CONSTRAINT IF EXISTS "(\w+)"/g)].map((m) => m[1]);
    const adds = [...statements.matchAll(/ADD CONSTRAINT "(\w+)"/g)].map((m) => m[1]);
    expect(drops).toEqual(["ListeningRule_matchKind_domain"]);
    expect(adds).toEqual(["ListeningRule_matchKind_domain"]);
  });

  it("drops ONLY the constraint it re-adds — never a column, a table or a row", () => {
    expect(migration).toContain("HAND-WRITTEN MIGRATION");
    expect(statements).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(statements).not.toMatch(/\b(UPDATE|DELETE FROM|TRUNCATE)\b/i);
  });

  it("touches exactly one table, so a live deployment risks nothing else", () => {
    const touched = [...statements.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1]);
    expect([...new Set(touched)]).toEqual(["ListeningRule"]);
  });

  it("is re-appliable, because 0008-0016 were half-applied on this deployment", () => {
    // `IF EXISTS` on the drop is what makes a re-run a no-op rather than a
    // failed migration that blocks every later one.
    expect(statements).toContain("DROP CONSTRAINT IF EXISTS");
  });

  it("leaves matchValue NOT NULL, which is what the unique trigger index needs", () => {
    // The design decision worth pinning: an `assigned` rule stores the literal
    // '*' rather than NULL, because NULLs do not collide in a Postgres unique
    // index — a nullable column would let one project accumulate any number of
    // identical catch-all rules, every one of them matching every ticket.
    expect(statements).not.toMatch(/ALTER COLUMN "matchValue"/i);
    expect(sql).toMatch(/"matchValue"\s+VARCHAR\(128\)\s+NOT NULL/);
    expect(migration).toMatch(/NULLs do not collide/);
  });

  it("keeps the schema's own comment agreeing that a third kind exists", () => {
    // Prisma carries no CHECK, so the schema's doc comment is the only place a
    // reader of `schema.prisma` learns the domain — it must not still claim two.
    expect(schema).toMatch(/"status" \| "issuetype" \| "assigned"/);
  });
});
