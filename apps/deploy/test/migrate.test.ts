import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { acquireLock, MIGRATION_LOCK_ID, releaseLock, resolveSchemaPath } from "../src/bin/migrate.js";

/**
 * The migration lock.
 *
 * Every service container runs the migration before its own entrypoint, so N
 * replicas can reach it at the same instant. `prisma migrate deploy` is not
 * safe to run concurrently, and the failure mode is nasty: two processes race
 * on the `_prisma_migrations` bookkeeping and can leave a migration marked
 * failed, which then blocks every subsequent deploy.
 *
 * The lock is what prevents that, so it is tested against a fake Postgres
 * rather than trusted.
 */

/** A `$queryRawUnsafe` that answers the advisory-lock calls. */
function fakeDb(answers: boolean[]) {
  const statements: string[] = [];
  let call = 0;
  return {
    statements,
    db: {
      $queryRawUnsafe: (sql: string): Promise<unknown> => {
        statements.push(sql);
        if (sql.includes("pg_advisory_unlock")) return Promise.resolve([{ ok: true }]);
        const locked = answers[call] ?? false;
        call += 1;
        return Promise.resolve([{ locked }]);
      },
    },
  };
}

const noSleep = (): Promise<void> => Promise.resolve();

describe("acquireLock", () => {
  it("takes the lock when Postgres grants it on the first try", async () => {
    const { db, statements } = fakeDb([true]);
    expect(await acquireLock(db, 5_000, noSleep)).toBe(true);
    expect(statements[0]).toContain("pg_try_advisory_lock");
    expect(statements).toHaveLength(1);
  });

  it("waits for the holder and takes the lock when it is released", async () => {
    // The first two attempts find it held; the third succeeds.
    const { db } = fakeDb([false, false, true]);
    expect(await acquireLock(db, 5_000, noSleep)).toBe(true);
  });

  it("gives up rather than blocking forever behind a wedged holder", async () => {
    // A blocking `pg_advisory_lock` would hang here, and a container that
    // hangs forever never reports anything.
    const { db } = fakeDb([false, false, false]);
    expect(await acquireLock(db, 0, noSleep)).toBe(false);
  });

  it("uses one constant lock id, so every replica contends for the SAME lock", async () => {
    // Two different ids would mean two processes each holding "the" lock.
    const { db, statements } = fakeDb([true]);
    await acquireLock(db, 5_000, noSleep);
    expect(statements[0]).toContain(String(MIGRATION_LOCK_ID));
  });

  it("polls with try-lock, never with the blocking variant", async () => {
    const { db, statements } = fakeDb([false, true]);
    await acquireLock(db, 5_000, noSleep);
    for (const sql of statements) {
      expect(sql).not.toMatch(/pg_advisory_lock\(/);
    }
  });
});

describe("releaseLock", () => {
  it("unlocks the same id it locked", async () => {
    const { db, statements } = fakeDb([]);
    await releaseLock(db);
    expect(statements[0]).toContain("pg_advisory_unlock");
    expect(statements[0]).toContain(String(MIGRATION_LOCK_ID));
  });

  it("does not fail the process when the release itself fails", async () => {
    // The session is about to close, which releases the lock regardless; a
    // throw here would turn a successful migration into a failed container.
    const db = { $queryRawUnsafe: () => Promise.reject(new Error("connection lost")) };
    await expect(releaseLock(db)).resolves.toBeUndefined();
  });
});

describe("resolveSchemaPath", () => {
  it("points at a schema file that actually exists", () => {
    // Not just the right SHAPE: the path is handed to `prisma migrate deploy`,
    // and a path that looks right but resolves nowhere fails inside a
    // container with a message about a missing schema rather than about the
    // resolution that produced it.
    const path = resolveSchemaPath();
    expect(path).toMatch(/packages[/\\]db[/\\]prisma[/\\]schema\.prisma$/);
    expect(existsSync(path), `${path} does not exist`).toBe(true);
  });
});
