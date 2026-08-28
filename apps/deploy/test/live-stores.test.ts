import { AuditChain } from "@maestro/audit";
import { createDb, type Db } from "@maestro/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postgresChainLock, PrismaAuditStore } from "../src/stores/audit.js";
import { PrismaGateStore, sqlGateClaim } from "../src/stores/gates.js";
import { PrismaIdempotencyGuard, sqlClaimExecutor } from "../src/stores/idempotency.js";
import { PrismaRunContextStore } from "../src/stores/run-context.js";
import { prismaSqlExecutor, prismaTransactionRunner } from "../src/stores/sql.js";

/**
 * The stores against a REAL Postgres.
 *
 * The offline suites prove the logic; these prove the three guarantees that
 * are properties of the database and cannot be faked — the primary key that
 * makes `open` idempotent, the `ON CONFLICT` that makes `once` run an effect
 * once across connections, and the advisory lock that stops two writers from
 * forking the audit chain.
 *
 * Opt-in, exactly like `packages/db/test/live-guards.test.ts`:
 *
 *   docker run -d --rm -p 55432:5432 -e POSTGRES_PASSWORD=maestro \
 *     -e POSTGRES_DB=maestro_test --name maestro-pg postgres:18-alpine
 *   TEST_DATABASE_URL=postgresql://postgres:maestro@localhost:55432/maestro_test \
 *     pnpm -F @maestro/deploy test
 *
 * Without the variable the whole file is skipped, so the wave gate stays
 * offline.
 */
const url = process.env["TEST_DATABASE_URL"];
const live = url === undefined ? describe.skip : describe;

live("stores against a live database", () => {
  let db: Db;
  /** A SECOND client — a different pool, standing in for a second worker. */
  let other: Db;

  beforeAll(async () => {
    db = createDb(url as string);
    other = createDb(url as string);
    await reset(db);
  });

  afterAll(async () => {
    await db.$disconnect();
    await other.$disconnect();
  });

  describe("RunContextStore", () => {
    it("reads back every field a run was created with", async () => {
      await seedRun(db, "PAY-201", "run-201");
      const context = await new PrismaRunContextStore(db.workflowRun).get("PAY-201");

      expect(context.runId).toBe("run-201");
      expect(context.app?.adoRepo).toBe("core-api");
      expect(context.branch).toBe("maestro/PAY-201");
      expect(context.verification).toEqual([{ name: "test", command: ["pnpm", "test"] }]);
    });

    it("patches one field without disturbing the others", async () => {
      await seedRun(db, "PAY-202", "run-202");
      const store = new PrismaRunContextStore(db.workflowRun);
      const before = await store.get("PAY-202");

      await store.patch("PAY-202", { prId: 77 });
      const after = await store.get("PAY-202");

      expect(after.prId).toBe(77);
      expect(after.branch).toBe(before.branch);
      expect(after.verification).toEqual(before.verification);
      expect(after.protectedPaths).toEqual(before.protectedPaths);
    });

    it("ignores a run that has finished", async () => {
      await seedRun(db, "PAY-203", "run-203");
      await db.workflowRun.update({ where: { id: "run-203" }, data: { status: "done" } });
      await expect(new PrismaRunContextStore(db.workflowRun).get("PAY-203")).rejects.toThrow(
        /no live run/,
      );
    });
  });

  describe("GateStore", () => {
    /**
     * THE gate test, and it is written the hard way on purpose.
     *
     * The version this replaces made three mistakes that together hid a real
     * production defect (a Prisma `upsert` that compiles to `SELECT`-then-
     * `INSERT` on a composite key, not to `ON CONFLICT`):
     *
     *  1. It called `Promise.all` and asserted only on the ROWS. A racer that
     *     threw `P2002` failed the whole `Promise.all`, but the surviving
     *     assertions — one row, equal anchors — were still true of the row that
     *     did get written, so the failure had to be read out of a stack trace
     *     rather than out of a count. `allSettled` plus an explicit `rejected`
     *     count is what turns "a worker could not open the gate" into an
     *     assertion.
     *  2. It ran ONCE. A lost race is probabilistic; a single attempt that
     *     happens to serialise proves nothing.
     *  3. It reused one run id, so by the time it ran the row was usually
     *     already there — and the race exists ONLY on the first open. Against
     *     the old code a warm row failed 0 times out of 6 and a cold row 94
     *     times out of 120. Each round now seeds a fresh run.
     *
     * Six writers on six pools, twenty rounds, cold every time. Every call must
     * succeed, one row must exist, and all six must report the SAME `openedAt`
     * — the M88 escalation ladder's anchor, which the losers must read rather
     * than set from the instant they happened to carry.
     */
    it("opens one gate with no failed caller when six cold workers race", async () => {
      const pools = [db, other, ...Array.from({ length: 4 }, () => createDb(url as string))];
      const extra = pools.slice(2);
      try {
        let rejections = 0;
        let calls = 0;

        for (let round = 0; round < 20; round += 1) {
          const runId = `run-race-${round}`;
          await seedRun(db, `PAY-9${round}`, runId);

          const stores = pools.map(
            (pool) =>
              new PrismaGateStore(pool.gate, pool.auditLog, () => Promise.resolve(`PAY-9${round}`),
                sqlGateClaim(prismaSqlExecutor(pool))),
          );
          // Deliberately DIFFERENT instants: a loser that wrote its own would
          // move the anchor and silently restart the ladder.
          const settled = await Promise.allSettled(
            stores.map((store, index) =>
              store.open(
                runId,
                "4",
                "product-owners",
                new Date(Date.UTC(2026, 7, 1 + index, 9)).toISOString(),
              ),
            ),
          );

          calls += settled.length;
          rejections += settled.filter((result) => result.status === "rejected").length;

          const rows = await db.gate.findMany({ where: { runId } });
          expect(rows).toHaveLength(1);

          const anchors = new Set(
            settled.flatMap((r) => (r.status === "fulfilled" ? [r.value.openedAt] : [])),
          );
          // One anchor, and it is the one the table holds.
          expect([...anchors]).toEqual([rows[0]?.openedAt.toISOString()]);
        }

        expect(calls).toBe(120);
        // The assertion the old test could not make. Against the shipped
        // `upsert` this was 94.
        expect(rejections).toBe(0);
      } finally {
        await Promise.all(extra.map((pool) => pool.$disconnect()));
      }
    });

    it("appends fired ladder steps without losing a concurrent one", async () => {
      await seedRun(db, "PAY-211", "run-211");
      const a = new PrismaGateStore(db.gate, db.auditLog, () => Promise.resolve("PAY-211"),
        sqlGateClaim(prismaSqlExecutor(db)));
      const b = new PrismaGateStore(other.gate, other.auditLog, () => Promise.resolve("PAY-211"),
        sqlGateClaim(prismaSqlExecutor(other)));
      await a.open("run-211", "4", "product-owners", "2026-08-01T09:00:00.000Z");

      await Promise.all([
        a.markFired("run-211", "4", ["reminder-24h"]),
        b.markFired("run-211", "4", ["escalation-72h"]),
      ]);

      const record = await a.get("run-211", "4");
      // A read-modify-write would have lost one of the two.
      expect([...(record?.firedStepIds ?? [])].sort()).toEqual([
        "escalation-72h",
        "reminder-24h",
      ]);
    });

    it("refuses to close a gate that the database does not have", async () => {
      const store = new PrismaGateStore(db.gate, db.auditLog, () => Promise.resolve("PAY-212"),
        sqlGateClaim(prismaSqlExecutor(db)));
      await expect(store.close("run-missing", "4", "2026-08-02T10:00:00.000Z")).rejects.toThrow(
        /no gate/,
      );
    });
  });

  describe("IdempotencyGuard", () => {
    /**
     * The guarantee `InMemoryIdempotency` cannot make. Two guards on two
     * separate connection pools — two worker processes, as far as Postgres is
     * concerned — call `once` with the same key at the same time. The effect
     * must run exactly once.
     */
    it("runs an effect once across two connections", async () => {
      const guardA = new PrismaIdempotencyGuard(db.idempotencyKey, sqlClaimExecutor(prismaSqlExecutor(db)), {
        pollIntervalMs: 10,
      });
      const guardB = new PrismaIdempotencyGuard(
        other.idempotencyKey,
        sqlClaimExecutor(prismaSqlExecutor(other)),
        { pollIntervalMs: 10 },
      );

      let calls = 0;
      const effect = async (): Promise<string> => {
        calls += 1;
        // Long enough that the loser is genuinely waiting on the winner.
        await new Promise((resolve) => setTimeout(resolve, 120));
        return "comment-4711";
      };

      const [ra, rb] = await Promise.all([
        guardA.once("live:post:PAY-220", effect),
        guardB.once("live:post:PAY-220", effect),
      ]);

      expect(calls).toBe(1);
      expect(ra).toBe("comment-4711");
      expect(rb).toBe("comment-4711");
    });

    it("replays the stored result on a later retry without re-running", async () => {
      const guard = new PrismaIdempotencyGuard(
        db.idempotencyKey,
        sqlClaimExecutor(prismaSqlExecutor(db)),
      );
      let calls = 0;
      const effect = (): Promise<number> => {
        calls += 1;
        return Promise.resolve(42);
      };

      expect(await guard.once("live:once:PAY-221", effect)).toBe(42);
      expect(await guard.once("live:once:PAY-221", effect)).toBe(42);
      expect(calls).toBe(1);
    });

    it("does not remember a failure, so a retry may run", async () => {
      const guard = new PrismaIdempotencyGuard(
        db.idempotencyKey,
        sqlClaimExecutor(prismaSqlExecutor(db)),
      );
      await expect(
        guard.once("live:fail:PAY-222", () => Promise.reject(new Error("jira down"))),
      ).rejects.toThrow("jira down");
      expect(await guard.once("live:fail:PAY-222", () => Promise.resolve("ok"))).toBe("ok");
    });

    it("refuses a done row with no completion instant (CHECK constraint)", async () => {
      await expect(
        db.idempotencyKey.create({
          data: { key: "live:bad", state: "done", claimedAt: new Date(), completedAt: null },
        }),
      ).rejects.toThrow();
    });
  });

  describe("AuditChain under the advisory lock", () => {
    /**
     * THE audit test. Two chains on two connection pools append concurrently.
     * With a process-local lock each would read the same head and mint the
     * same `seq` with the same `prevHash`; the unique index would reject one
     * and a record would be LOST. With the database holding the lock, the
     * second writer waits, reads the first one's record as its head, and the
     * chain comes out gapless and verifiable.
     */
    it("keeps the chain gapless when two processes write at once", async () => {
      await clearAuditLog(db);

      const chainA = new AuditChain({
        store: new PrismaAuditStore(db.auditLog),
        lock: postgresChainLock(prismaTransactionRunner(db)),
      });
      const chainB = new AuditChain({
        store: new PrismaAuditStore(other.auditLog),
        lock: postgresChainLock(prismaTransactionRunner(other)),
      });

      const appends: Array<Promise<unknown>> = [];
      for (let i = 0; i < 6; i++) {
        const chain = i % 2 === 0 ? chainA : chainB;
        appends.push(
          chain.append({
            actor: "maestro-worker",
            action: "RUN_STARTED",
            subject: `PAY-3${i}`,
          }),
        );
      }
      await Promise.all(appends);

      const stored = await new PrismaAuditStore(db.auditLog).read();
      expect(stored.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);

      // Gapless is not enough — the links must hold, which is what a fork
      // would break. `verify` re-hashes every record from genesis.
      const verification = await chainA.verify();
      expect(verification.ok).toBe(true);
    });
  });
});

/** A run row plus the application it points at. */
async function seedRun(db: Db, ticket: string, runId: string): Promise<void> {
  await db.application.upsert({
    where: { appId: "core-api" },
    create: {
      appId: "core-api",
      displayName: "Core API",
      adoProject: "Core",
      adoRepo: "core-api",
      platform: "linux-node",
      maestroYamlPresent: true,
      createdVia: "onboarding",
    },
    update: {},
  });
  await db.workflowRun.upsert({
    where: { id: runId },
    create: {
      id: runId,
      ticketKey: ticket,
      appId: "core-api",
      mode: "full_auto",
      dataClass: "dahili",
      step: "1",
      status: "running",
      startedAt: new Date("2026-08-01T09:00:00.000Z"),
      locale: "tr",
      variantId: "v1",
      templateVersion: "analysis@1.0.0",
      workspacePath: `/w/${ticket}`,
      workspacePresent: true,
      protectedPathsJson: ["infra/**"],
      verificationJson: [{ name: "test", command: ["pnpm", "test"] }],
      branch: `maestro/${ticket}`,
      targetBranch: "main",
    },
    update: {},
  });
}

/**
 * Clean slate, in dependency order.
 *
 * `AuditLog` needs `DISABLE TRIGGER`, and that is the point rather than a
 * nuisance: migration 0002 makes the table append-only for every client, so a
 * plain `deleteMany` is REFUSED — as this suite discovered. Disabling the
 * trigger for the length of one statement is a deliberate, local, test-only
 * act on a throwaway database; the alternative would be tests that only pass
 * the first time they are run.
 */
async function reset(db: Db): Promise<void> {
  await db.gate.deleteMany({});
  await db.idempotencyKey.deleteMany({});
  await db.publishState.deleteMany({});
  await clearAuditLog(db);
  await db.workflowRun.deleteMany({});
  await db.application.deleteMany({});
}

async function clearAuditLog(db: Db): Promise<void> {
  await db.$executeRawUnsafe('ALTER TABLE "AuditLog" DISABLE TRIGGER "AuditLog_append_only"');
  try {
    await db.$executeRawUnsafe('DELETE FROM "AuditLog"');
  } finally {
    await db.$executeRawUnsafe('ALTER TABLE "AuditLog" ENABLE TRIGGER "AuditLog_append_only"');
  }
}
