import { describe, expect, it } from "vitest";
import {
  decode,
  encode,
  IdempotencyTimeoutError,
  PrismaIdempotencyGuard,
  type ClaimExecutor,
  type IdempotencyDelegate,
  type IdempotencyRow,
} from "../src/stores/idempotency.js";

/**
 * The table-backed guard, against an in-memory table that behaves like the
 * real one.
 *
 * The fake's `claim` is the whole point: it is a Map insert that succeeds for
 * exactly ONE caller per key, which is what `INSERT ... ON CONFLICT DO
 * NOTHING` does in Postgres. Everything the guard promises about concurrency
 * rests on that single atomic step, so the double models it exactly and
 * nothing else.
 */
function fakeTable(): {
  keys: IdempotencyDelegate;
  claims: ClaimExecutor;
  rows: Map<string, IdempotencyRow>;
} {
  const rows = new Map<string, IdempotencyRow>();
  return {
    rows,
    claims: {
      claim: (key, at) => {
        if (rows.has(key)) return Promise.resolve(false);
        rows.set(key, { key, state: "running", resultJson: null, completedAt: null });
        void at;
        return Promise.resolve(true);
      },
    },
    keys: {
      findUnique: ({ where }) => Promise.resolve(rows.get(where.key) ?? null),
      update: ({ where, data }) => {
        const existing = rows.get(where.key);
        if (existing === undefined) throw new Error(`no row ${where.key}`);
        rows.set(where.key, {
          ...existing,
          state: data.state,
          resultJson: data.resultJson,
          completedAt: data.completedAt,
        });
        return Promise.resolve(undefined);
      },
      delete: ({ where }) => {
        rows.delete(where.key);
        return Promise.resolve(undefined);
      },
    },
  };
}

const instant = (): Promise<void> => Promise.resolve();

describe("PrismaIdempotencyGuard", () => {
  it("runs the effect once and replays the stored result on a retry", async () => {
    const table = fakeTable();
    const guard = new PrismaIdempotencyGuard(table.keys, table.claims, { sleep: instant });

    let calls = 0;
    const effect = (): Promise<string> => {
      calls += 1;
      return Promise.resolve("comment-4711");
    };

    expect(await guard.once("post:PAY-101", effect)).toBe("comment-4711");
    expect(await guard.once("post:PAY-101", effect)).toBe("comment-4711");
    expect(await guard.once("post:PAY-101", effect)).toBe("comment-4711");
    expect(calls).toBe(1);
  });

  /**
   * THE test. Two workers call `once` with the same key at the same time; the
   * effect must run exactly once and both must see the same answer.
   *
   * The effect below does not resolve until both callers are inside the guard,
   * so the second one genuinely arrives while the first is still running —
   * a sequential implementation would deadlock here rather than pass.
   */
  it("runs the effect once when two workers race the same key", async () => {
    const table = fakeTable();
    const options = { sleep: instant, pollIntervalMs: 0 };
    const workerA = new PrismaIdempotencyGuard(table.keys, table.claims, options);
    const workerB = new PrismaIdempotencyGuard(table.keys, table.claims, options);

    let calls = 0;
    let releaseEffect: (() => void) | undefined;
    const bothInside = new Promise<void>((resolve) => {
      releaseEffect = resolve;
    });

    const effect = async (): Promise<string> => {
      calls += 1;
      await bothInside;
      return "one-comment";
    };

    const a = workerA.once("post:PAY-101", effect);
    const b = workerB.once("post:PAY-101", effect);

    // Let the loser reach its polling loop before the winner finishes.
    await Promise.resolve();
    await Promise.resolve();
    releaseEffect?.();

    expect(await a).toBe("one-comment");
    expect(await b).toBe("one-comment");
    expect(calls).toBe(1);
  });

  it("does not remember a failure, so the next attempt may retry", async () => {
    const table = fakeTable();
    const guard = new PrismaIdempotencyGuard(table.keys, table.claims, { sleep: instant });

    await expect(
      guard.once("post:PAY-101", () => Promise.reject(new Error("jira down"))),
    ).rejects.toThrow("jira down");

    // The claim is released, so the row is gone and a retry may take it.
    expect(table.rows.has("post:PAY-101")).toBe(false);
    expect(await guard.once("post:PAY-101", () => Promise.resolve("ok"))).toBe("ok");
  });

  it("reports the original failure, not a cleanup failure", async () => {
    const table = fakeTable();
    const exploding: IdempotencyDelegate = {
      ...table.keys,
      delete: () => Promise.reject(new Error("connection reset during cleanup")),
    };
    const guard = new PrismaIdempotencyGuard(exploding, table.claims, { sleep: instant });

    await expect(
      guard.once("post:PAY-101", () => Promise.reject(new Error("jira down"))),
    ).rejects.toThrow("jira down");
  });

  it("replays a result of undefined without re-running the effect", async () => {
    const table = fakeTable();
    const guard = new PrismaIdempotencyGuard(table.keys, table.claims, { sleep: instant });

    let calls = 0;
    const effect = (): Promise<void> => {
      calls += 1;
      return Promise.resolve();
    };

    expect(await guard.once("label:PAY-101", effect)).toBeUndefined();
    expect(await guard.once("label:PAY-101", effect)).toBeUndefined();
    expect(calls).toBe(1);
  });

  /**
   * Giving up beats guessing. After the timeout we still do not know whether
   * the other worker posted the comment, and "probably not" is not a basis for
   * posting a second one to a bank's ticket.
   */
  it("times out rather than running an effect the other worker may have run", async () => {
    const table = fakeTable();
    // A claim taken by somebody else who never finishes.
    await table.claims.claim("post:PAY-101", new Date());

    let clock = 0;
    const guard = new PrismaIdempotencyGuard(table.keys, table.claims, {
      waitTimeoutMs: 50,
      pollIntervalMs: 10,
      now: () => new Date(clock),
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
    });

    let calls = 0;
    await expect(
      guard.once("post:PAY-101", () => {
        calls += 1;
        return Promise.resolve("second comment");
      }),
    ).rejects.toBeInstanceOf(IdempotencyTimeoutError);
    expect(calls).toBe(0);
  });

  it("never puts a connection string or password in its timeout message", async () => {
    const table = fakeTable();
    await table.claims.claim("post:PAY-101", new Date());
    let clock = 0;
    const guard = new PrismaIdempotencyGuard(table.keys, table.claims, {
      waitTimeoutMs: 10,
      pollIntervalMs: 5,
      now: () => new Date(clock),
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
    });

    const error = await guard.once("post:PAY-101", () => Promise.resolve(1)).catch((e: Error) => e);
    expect((error as Error).message).not.toMatch(/postgres|password|@|:\/\//i);
  });
});

describe("result envelope", () => {
  it("round-trips values that JSON alone would confuse", () => {
    expect(decode(encode(undefined))).toBeUndefined();
    expect(decode(encode(null))).toBeNull();
    expect(decode(encode(false))).toBe(false);
    expect(decode(encode(0))).toBe(0);
    expect(decode(encode({ commentId: "c1" }))).toEqual({ commentId: "c1" });
  });

  it("refuses a stored result that is not in the envelope", () => {
    expect(() => decode("raw string")).toThrow(/envelope/);
  });
});
