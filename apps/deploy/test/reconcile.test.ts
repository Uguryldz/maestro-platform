import type { RunSummary } from "@maestro/bff";
import { AuditChain, InMemoryAuditStore } from "@maestro/audit";
import type { AuditEvent } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import {
  reconcileRunStatuses,
  type ReconcileDelegate,
  type ReconcileSource,
} from "../src/stores/reconcile.js";
import { TERMINAL_STATUSES } from "../src/stores/run-context.js";

/**
 * The reconciler, against a recording fake delegate and a real audit chain.
 *
 * The chain is the genuine `AuditChain` over an in-memory store rather than a
 * spy: "the status change is written to the audit trail" is half the point of
 * this file, and a spy would let a record that the real chain refuses (a bad
 * actor, an unknown action) pass here and fail in production.
 *
 * What is asserted is what the database cannot enforce on its own: which rows a
 * pass may touch, that a second pass is a no-op, and that a run the engine says
 * nothing about is LEFT ALONE.
 */

interface StoredRow {
  id: string;
  ticketKey: string;
  status: string;
}

/**
 * A `WorkflowRun` table that honours the conditional write.
 *
 * `updateMany`'s `notIn` filter is the idempotency guard itself, so the fake
 * has to actually evaluate it — a fake that ignored the where-clause and always
 * reported `count: 1` would make the second-pass test pass for the wrong
 * reason, which is the one failure mode these tests exist to catch.
 */
function fakeRuns(rows: StoredRow[]): ReconcileDelegate & { rows: StoredRow[]; updates: number } {
  const delegate = {
    rows,
    updates: 0,
    findMany(args: {
      where: { status: { notIn: string[] } };
    }): Promise<Array<{ id: string; ticketKey: string; status: string }>> {
      const skip = new Set(args.where.status.notIn);
      return Promise.resolve(
        rows.filter((r) => !skip.has(r.status)).map((r) => ({ ...r })),
      );
    },
    updateMany(args: {
      where: { id: string; status: { notIn: string[] } };
      data: { status: string };
    }): Promise<{ count: number }> {
      const skip = new Set(args.where.status.notIn);
      const target = rows.find((r) => r.id === args.where.id && !skip.has(r.status));
      if (target === undefined) return Promise.resolve({ count: 0 });
      target.status = args.data.status;
      delegate.updates += 1;
      return Promise.resolve({ count: 1 });
    },
  };
  return delegate as unknown as ReconcileDelegate & { rows: StoredRow[]; updates: number };
}

function fakeSource(summaries: RunSummary[]): ReconcileSource {
  return { list: () => Promise.resolve(summaries) };
}

/**
 * A real chain over the reference store.
 *
 * `InMemoryAuditStore` enforces the same three invariants the database indexes
 * do (unique `seq`, `hash` and `prevHash`), so a double-write this file is
 * meant to catch fails here the way it would in production rather than being
 * quietly absorbed by a permissive fake.
 */
function memoryChain(): { chain: AuditChain; store: InMemoryAuditStore } {
  const store = new InMemoryAuditStore();
  return { chain: new AuditChain({ store }), store };
}

/** The records written so far, in chain order. */
async function recorded(store: InMemoryAuditStore): Promise<AuditEvent[]> {
  return store.read();
}

function summary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    workflowId: "maestro-OPS-38",
    ticketKey: "OPS-38" as RunSummary["ticketKey"],
    runId: "ded1bfba-976f-4985-9472-5111ed893893",
    status: "failed",
    startedAt: "2026-08-16T08:07:39.000Z",
    closedAt: "2026-08-16T08:10:12.000Z",
    ...over,
  };
}

describe("reconcileRunStatuses", () => {
  it("marks a crashed workflow's row `fail`", async () => {
    const runs = fakeRuns([{ id: "maestro-OPS-38", ticketKey: "OPS-38", status: "running" }]);
    const { chain, store } = memoryChain();

    const report = await reconcileRunStatuses({ runs, source: fakeSource([summary()]), audit: chain });

    expect(report.reconciled).toBe(1);
    expect(runs.rows[0]?.status).toBe("fail");
    // The audit record is the operator's answer to "who closed this, and how".
    const events = await recorded(store);
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("RUN_CLOSED");
    expect(events[0]?.actor).toBe("maestro-worker");
    expect(events[0]?.subject).toBe("OPS-38");
    expect(events[0]?.meta).toMatchObject({
      status: "fail",
      source: "temporal",
      executionStatus: "failed",
      reconciled: true,
    });
    // Dated by the ENGINE's close time, not by the boot that noticed it.
    expect(events[0]?.at).toBe("2026-08-16T08:10:12.000Z");
  });

  it("marks a completed workflow's row `done`", async () => {
    const runs = fakeRuns([{ id: "maestro-OPS-40", ticketKey: "OPS-40", status: "running" }]);
    const { chain } = memoryChain();

    const report = await reconcileRunStatuses({
      runs,
      source: fakeSource([summary({ ticketKey: "OPS-40" as RunSummary["ticketKey"], status: "completed" })]),
      audit: chain,
    });

    expect(report.reconciled).toBe(1);
    expect(runs.rows[0]?.status).toBe("done");
  });

  /**
   * The idempotency guard, stated as the behaviour that matters: run the whole
   * pass twice against the same world and the second one must write nothing —
   * no row change, no second audit record.
   */
  it("is idempotent — a second pass changes nothing", async () => {
    const runs = fakeRuns([{ id: "maestro-OPS-38", ticketKey: "OPS-38", status: "running" }]);
    const { chain, store } = memoryChain();
    const deps = { runs, source: fakeSource([summary()]), audit: chain };

    const first = await reconcileRunStatuses(deps);
    const second = await reconcileRunStatuses(deps);

    expect(first.reconciled).toBe(1);
    expect(second.reconciled).toBe(0);
    expect(runs.updates).toBe(1);
    expect(await recorded(store)).toHaveLength(1);
    expect(runs.rows[0]?.status).toBe("fail");
  });

  /**
   * The write-side half of idempotency, isolated.
   *
   * Two workers booting together both read the row as `running` and both decide
   * to settle it — the read filter cannot help, because at read time neither
   * pass had written anything. What saves it is the conditional `updateMany`:
   * the loser's write matches zero rows and it must NOT append a second
   * `RUN_CLOSED` for one closure.
   *
   * Simulated by settling the row behind the pass's back, between its read and
   * its write, which is exactly what the racing worker would do.
   */
  it("writes nothing when another pass settled the row first", async () => {
    const rows: StoredRow[] = [{ id: "maestro-OPS-38", ticketKey: "OPS-38", status: "running" }];
    const runs = fakeRuns(rows);
    const { chain, store } = memoryChain();

    const raced: ReconcileSource = {
      list: () => {
        // The other worker got there first.
        rows[0]!.status = "fail";
        return Promise.resolve([summary()]);
      },
    };

    const report = await reconcileRunStatuses({ runs, source: raced, audit: chain });

    expect(report.reconciled).toBe(0);
    expect(runs.updates).toBe(0);
    expect(await recorded(store)).toHaveLength(0);
    expect(rows[0]?.status).toBe("fail");
  });

  /**
   * Fail-closed. The engine has no execution for this ticket — retention may
   * have dropped it, or the namespace may have been rebuilt — so the truth is
   * UNKNOWN, and `running` is the status that keeps a human looking at it.
   * Writing `done` here would retire the row from every dashboard and hide any
   * gate still waiting on it.
   */
  it("leaves a run the engine knows nothing about as `running`", async () => {
    const runs = fakeRuns([{ id: "maestro-OPS-99", ticketKey: "OPS-99", status: "running" }]);
    const { chain, store } = memoryChain();

    const report = await reconcileRunStatuses({ runs, source: fakeSource([]), audit: chain });

    expect(report.unknown).toBe(1);
    expect(report.reconciled).toBe(0);
    expect(runs.rows[0]?.status).toBe("running");
    expect(await recorded(store)).toHaveLength(0);
  });

  it("leaves a genuinely running workflow alone", async () => {
    const runs = fakeRuns([{ id: "maestro-OPS-34", ticketKey: "OPS-34", status: "running" }]);
    const { chain } = memoryChain();

    const report = await reconcileRunStatuses({
      runs,
      source: fakeSource([summary({ ticketKey: "OPS-34" as RunSummary["ticketKey"], status: "running", closedAt: null })]),
      audit: chain,
    });

    expect(report.stillRunning).toBe(1);
    expect(report.reconciled).toBe(0);
    expect(runs.rows[0]?.status).toBe("running");
  });

  /**
   * A row parked at `gate` is `Running` to the engine. Flattening it to
   * `running` would erase the fact that a human is being waited on, so a
   * reconcile pass must not consider those rows at all.
   */
  it("never touches a row the workflow owns (`gate`, `queued`, `handover`)", async () => {
    const runs = fakeRuns([
      { id: "r-gate", ticketKey: "OPS-1", status: "gate" },
      { id: "r-queued", ticketKey: "OPS-2", status: "queued" },
      { id: "r-handover", ticketKey: "OPS-3", status: "handover" },
    ]);
    const { chain } = memoryChain();

    const report = await reconcileRunStatuses({
      runs,
      source: fakeSource([
        summary({ ticketKey: "OPS-1" as RunSummary["ticketKey"], status: "failed" }),
        summary({ ticketKey: "OPS-2" as RunSummary["ticketKey"], status: "failed" }),
        summary({ ticketKey: "OPS-3" as RunSummary["ticketKey"], status: "failed" }),
      ]),
      audit: chain,
    });

    expect(report.reconciled).toBe(0);
    expect(runs.rows.map((r) => r.status)).toEqual(["gate", "queued", "handover"]);
  });

  /** A timeout is not a human decision, so it must not read as `cancelled`. */
  it("records a terminated or timed-out run as `fail`, not `cancelled`", async () => {
    const runs = fakeRuns([
      { id: "r-term", ticketKey: "OPS-7", status: "running" },
      { id: "r-timeout", ticketKey: "OPS-8", status: "running" },
    ]);
    const { chain } = memoryChain();

    await reconcileRunStatuses({
      runs,
      source: fakeSource([
        summary({ ticketKey: "OPS-7" as RunSummary["ticketKey"], status: "terminated" }),
        summary({ ticketKey: "OPS-8" as RunSummary["ticketKey"], status: "timed_out" }),
      ]),
      audit: chain,
    });

    expect(runs.rows.map((r) => r.status)).toEqual(["fail", "fail"]);
  });

  /** A re-run leaves several executions on one ticket; the newest is the one. */
  it("resolves a re-run ticket to its newest execution", async () => {
    const runs = fakeRuns([{ id: "maestro-OPS-50", ticketKey: "OPS-50", status: "running" }]);
    const { chain } = memoryChain();

    await reconcileRunStatuses({
      runs,
      source: fakeSource([
        summary({
          ticketKey: "OPS-50" as RunSummary["ticketKey"],
          status: "failed",
          startedAt: "2026-08-15T10:00:00.000Z",
        }),
        summary({
          ticketKey: "OPS-50" as RunSummary["ticketKey"],
          status: "completed",
          startedAt: "2026-08-16T10:00:00.000Z",
        }),
      ]),
      audit: chain,
    });

    expect(runs.rows[0]?.status).toBe("done");
  });

  /**
   * The backfill, as measured on the pilot: 16 rows all saying `running`
   * against an engine holding 11 failures, 1 completion and 4 live runs. One
   * pass settles the 12 closed ones and leaves the 4 alone.
   */
  it("aligns a whole drifted deployment in one pass", async () => {
    const rows: StoredRow[] = [];
    const executions: RunSummary[] = [];
    for (let i = 0; i < 11; i += 1) {
      rows.push({ id: `r-f${i}`, ticketKey: `OPS-F${i}`, status: "running" });
      executions.push(summary({ ticketKey: `OPS-F${i}` as RunSummary["ticketKey"], status: "failed" }));
    }
    rows.push({ id: "r-done", ticketKey: "OPS-D", status: "running" });
    executions.push(summary({ ticketKey: "OPS-D" as RunSummary["ticketKey"], status: "completed" }));
    for (let i = 0; i < 4; i += 1) {
      rows.push({ id: `r-live${i}`, ticketKey: `OPS-L${i}`, status: "running" });
      executions.push(
        summary({ ticketKey: `OPS-L${i}` as RunSummary["ticketKey"], status: "running", closedAt: null }),
      );
    }

    const runs = fakeRuns(rows);
    const { chain, store } = memoryChain();
    const deps = { runs, source: fakeSource(executions), audit: chain };

    const report = await reconcileRunStatuses(deps);

    expect(report).toEqual({ reconciled: 12, stillRunning: 4, unknown: 0 });
    expect(runs.rows.filter((r) => r.status === "fail")).toHaveLength(11);
    expect(runs.rows.filter((r) => r.status === "done")).toHaveLength(1);
    expect(runs.rows.filter((r) => r.status === "running")).toHaveLength(4);
    expect(await recorded(store)).toHaveLength(12);

    // And the boot after that one is a no-op.
    const second = await reconcileRunStatuses(deps);
    expect(second.reconciled).toBe(0);
    expect(await recorded(store)).toHaveLength(12);
  });
});

describe("TERMINAL_STATUSES", () => {
  /**
   * The reconciler writes `fail`, so `fail` must count as terminal. If it did
   * not, the dead run would keep the ticket's one live slot and the next
   * `/ai-start` would collide with the partial unique index (P2002) — the
   * ticket would become permanently un-rerunnable.
   */
  it("treats a failed run as finished", () => {
    expect([...TERMINAL_STATUSES]).toContain("fail");
  });

  /** The DB half of the same statement — the index must agree with the code. */
  it("matches the partial unique index's WHERE clause", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const path = fileURLToPath(
      new URL(
        "../../../packages/db/prisma/migrations/0011_failed_run_is_terminal/migration.sql",
        import.meta.url,
      ),
    );
    const sql = await readFile(path, "utf8");
    for (const status of TERMINAL_STATUSES) {
      expect(sql).toContain(`'${status}'`);
    }
  });
});
