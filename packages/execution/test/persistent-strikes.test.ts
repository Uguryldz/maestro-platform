import { describe, expect, it } from "vitest";
import { ExecutionConfigError } from "../src/errors.js";
import { PersistentStrikeLedger, type StrikeRecord, type StrikeStore } from "../src/persistent-strikes.js";
import type { StrikeKey } from "../src/strikes.js";
import { tickingClock } from "./helpers.js";

/** A store backed by a Map that OUTLIVES the ledger — the "restart" seam. */
function memoryStore(seed: readonly StrikeRecord[] = []): StrikeStore & { rows: Map<string, StrikeRecord> } {
  const rows = new Map<string, StrikeRecord>();
  for (const record of seed) rows.set(`${record.runId}/${record.scope}/${record.ref}`, record);
  return {
    rows,
    load: (runId) => Promise.resolve([...rows.values()].filter((r) => r.runId === runId)),
    save: (record) => {
      rows.set(`${record.runId}/${record.scope}/${record.ref}`, record);
      return Promise.resolve();
    },
    remove: (key) => {
      rows.delete(`${key.runId}/${key.scope}/${key.ref}`);
      return Promise.resolve();
    },
  };
}

const CI_KEY: StrikeKey = { runId: "run-000001", scope: "ci", ref: "fp-abc" };

function ledgerOver(store: StrikeStore, limit?: number): PersistentStrikeLedger {
  return new PersistentStrikeLedger({
    store,
    now: tickingClock(),
    ...(limit === undefined ? {} : { limit }),
  });
}

describe("PersistentStrikeLedger survives a restart (M54)", () => {
  it("THE POINT: a count carries across a new ledger over the same store", async () => {
    const store = memoryStore();

    const before = ledgerOver(store);
    await before.hydrate(CI_KEY.runId);
    expect(before.record(CI_KEY, "npm test exited 1").count).toBe(1);
    expect(before.record(CI_KEY, "npm test exited 1").count).toBe(2);
    await before.pendingWrites();

    // The worker is redeployed. An in-memory ledger restarts at zero here, and
    // the three-strike handover then never fires — the run retries the same
    // failing turn forever instead of reaching a human.
    const after = ledgerOver(store);
    await after.hydrate(CI_KEY.runId);
    const third = after.record(CI_KEY, "npm test exited 1");

    expect(third.count).toBe(3);
    expect(third.handover).toBe(true);
  });

  it("keeps the reasons across the restart — the handover note quotes them", async () => {
    const store = memoryStore();
    const before = ledgerOver(store);
    await before.hydrate(CI_KEY.runId);
    before.record(CI_KEY, "first failure");
    await before.pendingWrites();

    const after = ledgerOver(store);
    await after.hydrate(CI_KEY.runId);

    expect(after.state(CI_KEY)?.reasons).toEqual(["first failure"]);
    expect(after.record(CI_KEY, "second failure").reasons).toEqual(["first failure", "second failure"]);
  });

  it("keeps firstAt from the original strike, not the restart", async () => {
    const store = memoryStore();
    const before = ledgerOver(store);
    await before.hydrate(CI_KEY.runId);
    const first = before.record(CI_KEY, "boom");
    await before.pendingWrites();

    const after = ledgerOver(store);
    await after.hydrate(CI_KEY.runId);

    expect(after.record(CI_KEY, "boom").firstAt).toBe(first.firstAt);
  });

  it("clearing a key removes the ROW, so the next process does not re-read it", async () => {
    const store = memoryStore();
    const ledger = ledgerOver(store);
    await ledger.hydrate(CI_KEY.runId);
    ledger.record(CI_KEY, "boom");
    ledger.clear(CI_KEY);
    await ledger.pendingWrites();

    const after = ledgerOver(store);
    await after.hydrate(CI_KEY.runId);
    expect(after.state(CI_KEY)).toBeNull();
  });

  it("counts different refs separately — a green build does not absolve a gate", async () => {
    const store = memoryStore();
    const ledger = ledgerOver(store);
    await ledger.hydrate("run-000001");

    ledger.record(CI_KEY, "ci failure");
    const gate = ledger.record({ runId: "run-000001", scope: "gate", ref: "5" }, "rejected");

    expect(gate.count).toBe(1);
    expect(ledger.state(CI_KEY)?.count).toBe(1);
  });

  it("hydrate does not roll back a strike recorded since the load", async () => {
    const store = memoryStore();
    const ledger = ledgerOver(store);
    await ledger.hydrate(CI_KEY.runId);
    ledger.record(CI_KEY, "boom");

    // A retry that re-hydrates mid-turn must not reset the count to whatever
    // the row said before this turn's strike was queued.
    await ledger.hydrate(CI_KEY.runId);

    expect(ledger.state(CI_KEY)?.count).toBe(1);
  });

  it("only loads the run it was asked for", async () => {
    const store = memoryStore([
      { runId: "run-other", scope: "ci", ref: "fp-abc", count: 2, firstAt: "t", lastAt: "t", reasons: [] },
    ]);
    const ledger = ledgerOver(store);
    await ledger.hydrate("run-000001");

    expect(ledger.record(CI_KEY, "boom").count).toBe(1);
  });

  it("recomputes handover from the CURRENT limit, not the stored one", async () => {
    const store = memoryStore([
      { runId: "run-000001", scope: "ci", ref: "fp-abc", count: 2, firstAt: "t", lastAt: "t", reasons: [] },
    ]);

    // M71 can lower the limit between turns; a stored flag would keep
    // answering with the value configured when the row was written.
    const ledger = ledgerOver(store, 2);
    await ledger.hydrate("run-000001");

    expect(ledger.state(CI_KEY)?.handover).toBe(true);
  });

  it("stuckKeys reports what justified the handover", async () => {
    const store = memoryStore();
    const ledger = ledgerOver(store, 1);
    await ledger.hydrate("run-000001");
    ledger.record(CI_KEY, "boom");

    expect(ledger.stuckKeys("run-000001")).toHaveLength(1);
    expect(ledger.stuckKeys("run-other")).toHaveLength(0);
  });
});

describe("write-behind never becomes the turn's outcome", () => {
  it("a failing save does not throw from record, but is reported", async () => {
    const errors: unknown[] = [];
    const broken: StrikeStore = {
      load: () => Promise.resolve([]),
      save: () => Promise.reject(new Error("db down")),
      remove: () => Promise.resolve(),
    };
    const ledger = new PersistentStrikeLedger({
      store: broken,
      now: tickingClock(),
      onWriteError: (error) => errors.push(error),
    });
    await ledger.hydrate("run-000001");

    // The turn already failed for its own reason; replacing it with a database
    // error would tell the operator the wrong story.
    expect(() => ledger.record(CI_KEY, "boom")).not.toThrow();
    await expect(ledger.pendingWrites()).resolves.toBeUndefined();
    // But a ledger that quietly stopped persisting is a stuck-loop detector
    // that has stopped detecting.
    expect(errors).toHaveLength(1);
  });

  it("pendingWrites resolves only after the write was attempted", async () => {
    let saved = false;
    const slow: StrikeStore = {
      load: () => Promise.resolve([]),
      save: () =>
        new Promise((resolve) =>
          setImmediate(() => {
            saved = true;
            resolve();
          }),
        ),
      remove: () => Promise.resolve(),
    };
    const ledger = new PersistentStrikeLedger({ store: slow, now: tickingClock() });
    await ledger.hydrate("run-000001");
    ledger.record(CI_KEY, "boom");

    await ledger.pendingWrites();

    // A worker shut down between the strike and the row would otherwise hand
    // over on a count that no longer exists.
    expect(saved).toBe(true);
  });

  it("serialises writes to one key so they cannot land out of order", async () => {
    const order: number[] = [];
    const store: StrikeStore = {
      load: () => Promise.resolve([]),
      save: (record) => {
        order.push(record.count);
        return Promise.resolve();
      },
      remove: () => Promise.resolve(),
    };
    const ledger = new PersistentStrikeLedger({ store, now: tickingClock() });
    await ledger.hydrate("run-000001");

    ledger.record(CI_KEY, "one");
    ledger.record(CI_KEY, "two");
    ledger.record(CI_KEY, "three");
    await ledger.pendingWrites();

    expect(order).toEqual([1, 2, 3]);
  });

  it("forget drops the memory but keeps the rows", async () => {
    const store = memoryStore();
    const ledger = ledgerOver(store);
    await ledger.hydrate(CI_KEY.runId);
    ledger.record(CI_KEY, "boom");
    await ledger.pendingWrites();

    ledger.forget(CI_KEY.runId);

    expect(ledger.state(CI_KEY)).toBeNull();
    expect(store.rows.size).toBe(1);
  });

  it("refuses a nonsensical limit rather than counting to it", () => {
    expect(() => ledgerOver(memoryStore(), 0)).toThrow(ExecutionConfigError);
    expect(() => ledgerOver(memoryStore(), 1.5)).toThrow(ExecutionConfigError);
  });
});
