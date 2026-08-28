import type { AuditEvent } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import {
  AuditChain,
  AuditChainError,
  AuditActorError,
  GENESIS,
  InMemoryAuditStore,
  LocalChainLock,
  verifyChain,
  type AuditStore,
  type ChainLock,
} from "../src/index.js";
import { SAMPLE_INPUTS, fixedClock, sampleChain } from "./helpers.js";

/**
 * A store whose reads and writes take a turn of the event loop — the shape of a
 * real database call. Without ordering, two concurrent appends both read the
 * same head between the awaits.
 */
class SlowStore implements AuditStore {
  private readonly inner = new InMemoryAuditStore();

  async head(): Promise<AuditEvent | null> {
    await Promise.resolve();
    return this.inner.head();
  }

  async append(event: AuditEvent): Promise<void> {
    await Promise.resolve();
    return this.inner.append(event);
  }

  read(range?: { fromSeq?: number; toSeq?: number }): Promise<AuditEvent[]> {
    return this.inner.read(range);
  }
}

/** Deliberately does not serialise: used to prove the lock is what saves the chain. */
const NO_LOCK: ChainLock = { withLock: (fn) => fn() };

describe("appending to the chain", () => {
  it("starts at seq 1 with prevHash genesis", async () => {
    const store = new InMemoryAuditStore();
    const chain = new AuditChain({ store, clock: fixedClock("2026-08-08T09:00:00.000Z") });
    const event = await chain.append(SAMPLE_INPUTS[0]!);

    expect(event.seq).toBe(1);
    expect(event.prevHash).toBe(GENESIS);
    expect(event.at).toBe("2026-08-08T09:00:00.000Z");
  });

  it("links every record to the previous one and verifies as a whole", async () => {
    const { events, chain } = await sampleChain();

    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i]!.prevHash).toBe(events[i - 1]!.hash);
    }
    expect(verifyChain(events).ok).toBe(true);
    expect((await chain.verify()).ok).toBe(true);
  });

  it("normalises the timestamp to UTC so the stored and hashed instant agree", async () => {
    const store = new InMemoryAuditStore();
    const chain = new AuditChain({ store, clock: fixedClock("2026-08-08T09:00:00.000Z") });
    const event = await chain.append({ ...SAMPLE_INPUTS[0]!, at: "2026-08-08T12:00:00.000+03:00" });

    expect(event.at).toBe("2026-08-08T09:00:00.000Z");
    expect(verifyChain([event]).ok).toBe(true);
  });

  it("refuses an unattributable actor before anything is written", async () => {
    const store = new InMemoryAuditStore();
    const chain = new AuditChain({ store });
    await expect(chain.append({ actor: "root", action: "RUN_STARTED", subject: "X-1" })).rejects.toThrow(
      AuditActorError,
    );
    expect(await store.head()).toBeNull();
  });

  it("refuses a gate decision recorded for a non-human actor (M32/M101)", async () => {
    const store = new InMemoryAuditStore();
    const chain = new AuditChain({ store });

    for (const actor of ["ai-via:po.demir@ugurbank.corp", "maestro-worker"]) {
      await expect(chain.append({ actor, action: "GATE_APPROVE", subject: "UGURPAY-101" })).rejects.toThrow(
        AuditChainError,
      );
      await expect(chain.append({ actor, action: "GATE_REJECT", subject: "UGURPAY-101" })).rejects.toThrow(
        /may only be recorded for a human actor/,
      );
    }
    expect(await store.head()).toBeNull();
  });

  it("refuses an invalid explicit instant", async () => {
    const chain = new AuditChain({ store: new InMemoryAuditStore() });
    await expect(
      chain.append({ actor: "maestro-worker", action: "RUN_STARTED", subject: "X-1", at: "not-a-date" }),
    ).rejects.toThrow(AuditChainError);
  });
});

describe("single-writer ordering", () => {
  it("keeps the chain intact under 50 concurrent appends", async () => {
    const store = new SlowStore();
    const chain = new AuditChain({ store, lock: new LocalChainLock(), clock: fixedClock("2026-08-08T09:00:00.000Z") });

    const events = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        chain.append({ actor: "maestro-worker", action: "CI_RESULT", subject: `UGURPAY-${100 + i}` }),
      ),
    );

    const stored = await store.read();
    expect(stored).toHaveLength(50);
    expect(stored.map((event) => event.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(new Set(events.map((event) => event.hash)).size).toBe(50);
    expect(verifyChain(stored).ok).toBe(true);
  });

  it("proves the lock is what prevents the fork: without it the chain breaks", async () => {
    const store = new SlowStore();
    const chain = new AuditChain({ store, lock: NO_LOCK, clock: fixedClock("2026-08-08T09:00:00.000Z") });

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        chain.append({ actor: "maestro-worker", action: "CI_RESULT", subject: `UGURPAY-${200 + i}` }),
      ),
    );

    // Every writer read the same empty head, so they all minted seq 1 pointing
    // at genesis; the store's append-only invariants reject all but the first.
    // Exactly one survives — asserting "fewer than 10" would also pass if nine
    // forks had been written.
    const written = await store.read();
    expect(written).toHaveLength(1);
    expect(written[0]!.seq).toBe(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(9);
  });

  it("keeps a multi-record run contiguous while another writer competes", async () => {
    const store = new SlowStore();
    const chain = new AuditChain({ store, clock: fixedClock("2026-08-08T09:00:00.000Z") });

    const [run] = await Promise.all([
      chain.appendMany(SAMPLE_INPUTS),
      chain.append({ actor: "maestro-worker", action: "QUOTA_WARN", subject: "claude-sub" }),
    ]);

    const seqs = run.map((event) => event.seq);
    expect(seqs).toEqual(seqs.map((_, i) => seqs[0]! + i));
    expect(verifyChain(await store.read()).ok).toBe(true);
  });

  it("does not poison the queue when one append fails", async () => {
    const store = new InMemoryAuditStore();
    const chain = new AuditChain({ store, clock: fixedClock("2026-08-08T09:00:00.000Z") });

    const results = await Promise.allSettled([
      chain.append({ actor: "maestro-worker", action: "RUN_STARTED", subject: "UGURPAY-1" }),
      chain.append({ actor: "root", action: "RUN_STARTED", subject: "UGURPAY-2" }),
      chain.append({ actor: "maestro-worker", action: "RUN_CLOSED", subject: "UGURPAY-1" }),
    ]);

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect((await store.read()).map((event) => event.seq)).toEqual([1, 2]);
    expect(verifyChain(await store.read()).ok).toBe(true);
  });
});

describe("store invariants", () => {
  it("rejects a duplicate hash and a non-advancing seq", async () => {
    const { events } = await sampleChain();
    const store = new InMemoryAuditStore(events);

    await expect(store.append({ ...events[4]!, seq: 6 })).rejects.toThrow(/hash_conflict/);
    await expect(store.append({ ...events[4]!, hash: "b".repeat(64), seq: 3 })).rejects.toThrow(AuditChainError);
    await expect(store.append({ ...events[4]!, hash: "b".repeat(64), seq: 3 })).rejects.toThrow(/sequence_conflict/);
  });

  it("rejects a second record claiming the same predecessor — the DB's prevHash index (D2)", async () => {
    const { events } = await sampleChain();
    const store = new InMemoryAuditStore(events);

    // `AuditLog.prevHash` is `@unique`, so this fork is impossible in Postgres.
    // A reference store that allowed it would hide fork bugs from every test.
    const fork: AuditEvent = { ...events[4]!, seq: 6, hash: "b".repeat(64) };
    await expect(store.append(fork)).rejects.toThrow(AuditChainError);
    await expect(store.append(fork)).rejects.toThrow(/prev_hash_conflict/);

    // And there is at most one genesis row, exactly as the index guarantees.
    const fresh = new InMemoryAuditStore();
    await fresh.append(events[0]!);
    await expect(fresh.append({ ...events[0]!, seq: 2, hash: "c".repeat(64) })).rejects.toThrow(
      /prev_hash_conflict/,
    );
  });

  it("reads inclusive ranges", async () => {
    const { store } = await sampleChain();
    expect((await store.read({ fromSeq: 2, toSeq: 4 })).map((event) => event.seq)).toEqual([2, 3, 4]);
  });
});
