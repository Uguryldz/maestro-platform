import { AuditChain } from "@maestro/audit";
import type { AuditEvent } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import {
  AUDIT_CHAIN_LOCK_KEY,
  postgresChainLock,
  PrismaAuditStore,
  type AuditLogDelegate,
  type AuditLogWriteRow,
  type TransactionRunner,
} from "../src/stores/audit.js";

/**
 * The Postgres audit store, against a fake that enforces the table's three
 * unique indexes.
 *
 * A double weaker than the real table would hide exactly the failures these
 * tests exist to catch — the same argument `InMemoryAuditStore`'s own comment
 * makes — so `seq`, `hash` and `prevHash` all reject duplicates here.
 */
function fakeLog(): { delegate: AuditLogDelegate; rows: AuditLogWriteRow[] } {
  const rows: AuditLogWriteRow[] = [];
  return {
    rows,
    delegate: {
      findFirst: () => {
        const head = [...rows].sort((a, b) => Number(b.seq - a.seq))[0];
        return Promise.resolve(head === undefined ? null : toRow(head));
      },
      findMany: ({ where }) => {
        const from = where.seq?.gte ?? -1n;
        const to = where.seq?.lte ?? 2n ** 62n;
        return Promise.resolve(
          rows
            .filter((row) => row.seq >= from && row.seq <= to)
            .sort((a, b) => Number(a.seq - b.seq))
            .map(toRow),
        );
      },
      create: ({ data }) => {
        for (const row of rows) {
          if (row.seq === data.seq) throw new Error("duplicate key value violates \"AuditLog_pkey\"");
          if (row.hash === data.hash) throw new Error("duplicate key value violates \"AuditLog_hash_key\"");
          if (row.prevHash === data.prevHash) {
            throw new Error("duplicate key value violates \"AuditLog_prevHash_key\"");
          }
        }
        rows.push(data);
        return Promise.resolve(undefined);
      },
    },
  };
}

function toRow(row: AuditLogWriteRow): {
  seq: bigint;
  at: Date;
  actor: string;
  action: AuditEvent["action"];
  subject: string;
  prevHash: string;
  hash: string;
  metaJson: unknown;
} {
  return { ...row, action: row.action };
}

describe("PrismaAuditStore", () => {
  it("appends a chain and reads it back in order", async () => {
    const log = fakeLog();
    const chain = new AuditChain({ store: new PrismaAuditStore(log.delegate) });

    await chain.append({ actor: "maestro-worker", action: "RUN_STARTED", subject: "PAY-101" });
    await chain.append({ actor: "maestro-worker", action: "GATE_OPEN", subject: "PAY-101 · 4" });

    const events = await new PrismaAuditStore(log.delegate).read();
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    expect(events[1]?.prevHash).toBe(events[0]?.hash);
  });

  it("reports the head, and null for an empty chain", async () => {
    const log = fakeLog();
    const store = new PrismaAuditStore(log.delegate);
    expect(await store.head()).toBeNull();

    const chain = new AuditChain({ store });
    await chain.append({ actor: "maestro-worker", action: "RUN_STARTED", subject: "PAY-101" });
    expect((await store.head())?.seq).toBe(1);
  });

  it("reads an inclusive slice", async () => {
    const log = fakeLog();
    const store = new PrismaAuditStore(log.delegate);
    const chain = new AuditChain({ store });
    for (let i = 0; i < 4; i++) {
      await chain.append({ actor: "maestro-worker", action: "RUN_STARTED", subject: `PAY-10${i}` });
    }
    expect((await store.read({ fromSeq: 2, toSeq: 3 })).map((e) => e.seq)).toEqual([2, 3]);
  });

  /**
   * The store must NOT pre-check. The unique indexes are checked atomically at
   * INSERT, and a read-then-check would be exactly the race the index closes.
   */
  it("lets the database reject a forked chain rather than pre-checking", async () => {
    const log = fakeLog();
    const store = new PrismaAuditStore(log.delegate);
    const chain = new AuditChain({ store });
    const first = await chain.append({
      actor: "maestro-worker",
      action: "RUN_STARTED",
      subject: "PAY-101",
    });

    // A second record claiming the same predecessor is a fork.
    await expect(store.append({ ...first, seq: 2, hash: `${"b".repeat(64)}` })).rejects.toThrow(
      /prevHash/,
    );
  });

  it("verifies the stored chain from genesis", async () => {
    const log = fakeLog();
    const chain = new AuditChain({ store: new PrismaAuditStore(log.delegate) });
    await chain.append({ actor: "maestro-worker", action: "RUN_STARTED", subject: "PAY-101" });
    await chain.append({ actor: "maestro-worker", action: "RUN_CLOSED", subject: "PAY-101" });
    expect((await chain.verify()).ok).toBe(true);
  });
});

describe("postgresChainLock", () => {
  it("takes the advisory lock before running the callback, inside a transaction", async () => {
    const calls: string[] = [];
    const runner: TransactionRunner = {
      transaction: async (fn) => {
        calls.push("begin");
        const result = await fn({
          query: (sql, params) => {
            calls.push(`${sql.trim()} ${String(params[0])}`);
            return Promise.resolve([]);
          },
        });
        calls.push("commit");
        return result;
      },
    };

    await postgresChainLock(runner).withLock(() => {
      calls.push("append");
      return Promise.resolve("done");
    });

    expect(calls).toEqual([
      "begin",
      `SELECT pg_advisory_xact_lock($1)::text ${String(AUDIT_CHAIN_LOCK_KEY)}`,
      "append",
      "commit",
    ]);
  });

  it("releases the lock by ending the transaction even when the append throws", async () => {
    let ended = false;
    const runner: TransactionRunner = {
      transaction: async (fn) => {
        try {
          return await fn({ query: () => Promise.resolve([]) });
        } finally {
          // A real transaction rolls back here, which releases the xact lock.
          ended = true;
        }
      },
    };

    await expect(
      postgresChainLock(runner).withLock(() => Promise.reject(new Error("insert failed"))),
    ).rejects.toThrow("insert failed");
    expect(ended).toBe(true);
  });
});
