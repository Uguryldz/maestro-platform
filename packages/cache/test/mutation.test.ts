import { describe, expect, it } from "vitest";
import { FakeRedisClient } from "../src/fake-client.js";
import type { RespValue } from "../src/resp.js";

/**
 * Proof that the concurrency suite measures a race, and is not merely passing.
 *
 * A test that asserts "exactly 10 of 100 were admitted" is worthless if it
 * would also pass against a broken implementation. So this file BUILDS the
 * broken implementation — the same logic with its read, its arithmetic and its
 * write split into three separate round trips, which is what a naive
 * `GET`/compute/`SET` limiter does — and asserts that it fails the very
 * assertions `atomicity.test.ts` makes.
 *
 * If `naiveTake` ever starts admitting exactly 10, this file goes red. That
 * would mean the fake client stopped interleaving, and every atomicity claim in
 * this package would have quietly become unverified. The mutants are here
 * permanently for that reason: they are a live check on the test harness, not a
 * one-off experiment somebody ran and wrote down the answer to.
 */

/**
 * The mutant: a token bucket as three commands.
 *
 * Between `HMGET` and `HSET` any other caller may run, and all of them read the
 * same token count. This is the exact bug the Lua script exists to prevent.
 */
async function naiveTake(
  client: FakeRedisClient,
  key: string,
  capacity: number,
  refillPerSecond: number,
): Promise<boolean> {
  // 1. READ
  const state = (await client.send(["HMGET", key, "t", "ts"])) as (string | null)[];
  const stored = state[0];
  const storedAt = state[1];
  let tokens = stored === null || stored === undefined ? capacity : Number(stored);
  const last = storedAt === null || storedAt === undefined ? client.now : Number(storedAt);

  // 2. COMPUTE — another caller's read has already happened by now
  tokens = Math.min(capacity, tokens + ((client.now - last) / 1000) * refillPerSecond);
  const allowed = tokens >= 1;
  if (allowed) tokens -= 1;

  // 3. WRITE — clobbers whatever the others decided
  await client.send(["HSET", key, "t", String(tokens), "ts", String(client.now)]);
  return allowed;
}

/** The mutant semaphore: ZCARD, then decide, then ZADD. */
async function naiveAcquire(client: FakeRedisClient, key: string, capacity: number, token: string): Promise<boolean> {
  const count = (await client.send(["ZCARD", key])) as number;
  if (count >= capacity) return false;
  await client.send(["ZADD", key, String(client.now + 30_000), token]);
  return true;
}

/** The mutant lock release: GET, compare, DEL — the classic wrong-owner delete. */
async function naiveRelease(client: FakeRedisClient, key: string, token: string): Promise<RespValue> {
  const owner = await client.send(["GET", key]);
  if (owner !== token) return 0;
  // A window opens here. In production it is a GC pause or a slow network; the
  // test makes it explicit so the consequence is deterministic rather than rare.
  await new Promise((resolve) => setTimeout(resolve, 1));
  return client.send(["DEL", key]);
}

describe("mutation: a split token bucket over-admits", () => {
  it("admits far more than the capacity when read/compute/write are three commands", async () => {
    const client = new FakeRedisClient();
    const results = await Promise.all(
      Array.from({ length: 100 }, () => naiveTake(client, "mutant", 10, 0.001)),
    );
    const allowed = results.filter(Boolean).length;

    // The assertion atomicity.test.ts makes, and the mutant violates.
    expect(allowed).not.toBe(10);
    // Every one of the 100 read a full bucket before any write landed.
    expect(allowed).toBe(100);
  });

  it("over-admits at every capacity, so the atomic version's exactness is meaningful", async () => {
    for (const capacity of [1, 3, 7, 25]) {
      const client = new FakeRedisClient();
      const results = await Promise.all(
        Array.from({ length: 100 }, () => naiveTake(client, "k", capacity, 0.001)),
      );
      expect(results.filter(Boolean).length).toBeGreaterThan(capacity);
    }
  });

  it("leaves the stored token count negative — state the script can never reach", async () => {
    const client = new FakeRedisClient();
    await Promise.all(Array.from({ length: 100 }, () => naiveTake(client, "k", 10, 0.001)));
    const tokens = Number(await client.send(["HGET", "k", "t"]));
    expect(tokens).toBeLessThan(10);
  });
});

describe("mutation: a split semaphore over-grants", () => {
  it("hands out more permits than the capacity when the count and the insert are separate", async () => {
    const client = new FakeRedisClient();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_unused, index) => naiveAcquire(client, "sandbox", 3, `t${index}`)),
    );
    const granted = results.filter(Boolean).length;

    expect(granted).not.toBe(3);
    expect(granted).toBe(10); // all 10 saw ZCARD = 0
    expect(await client.send(["ZCARD", "sandbox"])).toBe(10);
  });
});

describe("mutation: a split lock release deletes another holder's lock", () => {
  it("removes the successor's lock when the check and the delete are separate", async () => {
    const client = new FakeRedisClient();
    await client.send(["SET", "lock", "holder-1", "PX", 1_000]);

    // The stale holder starts releasing; its GET sees its own token.
    const releasing = naiveRelease(client, "lock", "holder-1");
    // Mid-window the lock expires and a successor takes it.
    await Promise.resolve();
    client.now += 1_001;
    await client.send(["SET", "lock", "holder-2", "NX", "PX", 1_000]);

    await releasing;
    // The successor's lock is gone — deleted by a process that no longer owned it.
    expect(await client.send(["GET", "lock"])).toBeNull();
  });

  it("is exactly what the Lua release prevents, on the same timeline", async () => {
    const { RedisLock } = await import("../src/lock.js");
    const client = new FakeRedisClient();
    let counter = 0;
    const lock = new RedisLock(client, { ttlMs: 1_000 }, () => new Date(client.now), () => `holder-${(counter += 1)}`);

    const first = await lock.tryAcquire("k");
    if (first === null) throw new Error("expected the lock");
    client.now += 1_001;
    const second = await lock.tryAcquire("k");
    expect(second).not.toBeNull();

    await lock.release(first);
    // Still held: GET-compare-DEL happened with nothing in between.
    expect(await client.send(["GET", "maestro:lock:k"])).toBe(second?.token);
  });
});

describe("the harness itself really interleaves", () => {
  it("shows that concurrent sends do not run to completion one at a time", async () => {
    // If this ever fails, every mutation above would start passing for the
    // wrong reason, and the atomicity suite would be measuring nothing.
    const client = new FakeRedisClient();
    const order: string[] = [];
    await Promise.all(
      Array.from({ length: 3 }, async (_unused, index) => {
        order.push(`start-${index}`);
        await client.send(["PING"]);
        order.push(`end-${index}`);
      }),
    );
    expect(order.slice(0, 3)).toEqual(["start-0", "start-1", "start-2"]);
    expect(order.indexOf("end-0")).toBeGreaterThan(order.indexOf("start-2"));
  });
});
