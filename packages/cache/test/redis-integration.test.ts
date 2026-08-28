import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRedisClient } from "../src/socket-client.js";
import type { RedisClient } from "../src/client.js";
import { RedisCache } from "../src/cache.js";
import { RedisLock } from "../src/lock.js";
import { RedisSemaphore } from "../src/semaphore.js";
import { RedisTokenBucket } from "../src/token-bucket.js";

/**
 * The same scenarios as `atomicity.test.ts`, against a real Redis.
 *
 * The in-memory client's Lua mirrors are hand-written TypeScript, so they could
 * in principle disagree with the Lua that actually runs in production. This
 * file is the check on that: identical inputs, identical assertions, real
 * `EVALSHA` against a real server. A divergence shows up as a red test here
 * rather than as a rate limit that behaves differently in the bank than it did
 * on a laptop.
 *
 * OPT-IN, and deliberately so. `MAESTRO_REDIS_URL` must be set:
 *
 *     docker run --rm -d -p 56379:6379 --name maestro-redis redis:7-alpine
 *     MAESTRO_REDIS_URL=redis://127.0.0.1:56379 pnpm --filter @maestro/cache test
 *
 * The gate must not depend on a container being up, and a suite that silently
 * needs one is a suite that fails on somebody else's machine for a reason that
 * has nothing to do with their change. What keeps this from becoming a
 * never-run test is that the logic it covers is ALSO covered by the fake-backed
 * suite — this file adds wire-level and Lua-level confirmation on top, rather
 * than being the only place a behaviour is checked.
 *
 * Every key is prefixed with a per-run id so a shared Redis cannot make two
 * runs interfere.
 */

const REDIS_URL = process.env["MAESTRO_REDIS_URL"];
const runId = `it-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// `describe.skipIf` rather than an early return: a skipped suite is reported as
// skipped, so "0 tests ran" cannot be mistaken for "everything passed".
describe.skipIf(REDIS_URL === undefined)("real Redis", () => {
  let client: RedisClient;

  beforeAll(async () => {
    client = createRedisClient(REDIS_URL as string, { commandTimeoutMs: 5_000 });
    expect(await client.send(["PING"])).toBe("PONG");
  });

  afterAll(async () => {
    if (client !== undefined) await client.close();
  });

  describe("token bucket (M19)", () => {
    it("admits exactly 10 of 100 concurrent takes — the Lua is atomic on the wire", async () => {
      const bucket = new RedisTokenBucket(client, {
        capacity: 10,
        refillPerSecond: 0.001,
        keyPrefix: `${runId}:rl`,
      });
      const results = await Promise.all(Array.from({ length: 100 }, () => bucket.take("openai")));
      expect(results.filter((r) => r.allowed).length).toBe(10);
    });

    it("agrees with the in-memory mirror at several capacities", async () => {
      for (const capacity of [1, 3, 7, 25]) {
        const bucket = new RedisTokenBucket(client, {
          capacity,
          refillPerSecond: 0.001,
          keyPrefix: `${runId}:rl-${capacity}`,
        });
        const results = await Promise.all(Array.from({ length: 100 }, () => bucket.take("k")));
        expect(results.filter((r) => r.allowed).length).toBe(capacity);
      }
    });

    it("charges a multi-token cost atomically", async () => {
      const bucket = new RedisTokenBucket(client, {
        capacity: 12,
        refillPerSecond: 0.001,
        keyPrefix: `${runId}:rl-cost`,
      });
      const results = await Promise.all(Array.from({ length: 20 }, () => bucket.take("k", 3)));
      expect(results.filter((r) => r.allowed).length).toBe(4);
    });

    it("refills on the real clock", async () => {
      const bucket = new RedisTokenBucket(client, {
        capacity: 2,
        refillPerSecond: 20, // a token every 50ms
        keyPrefix: `${runId}:rl-refill`,
      });
      expect((await bucket.take("k")).allowed).toBe(true);
      expect((await bucket.take("k")).allowed).toBe(true);
      const refused = await bucket.take("k");
      expect(refused.allowed).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, refused.waitMs + 30));
      expect((await bucket.take("k")).allowed).toBe(true);
    });

    /**
     * `if elapsed < 0 then elapsed = 0` — the monotonic-refill guard, pinned.
     *
     * An NTP step backwards, or a replica whose clock trails the one that last
     * wrote the bucket, makes `now - last` negative. Without the clamp the
     * refill term goes negative too... and `math.min(capacity, tokens + neg)`
     * quietly LOWERS the count rather than raising it, which is why deleting
     * the line left every existing test green: the visible effect is not "more
     * tokens" but "the stored timestamp walks backwards", and each later call
     * then measures its elapsed time from that stale instant and mints the same
     * tokens twice.
     *
     * So this asserts the invariant directly. The bucket is drained at a late
     * clock, then hammered at an EARLIER one: a limit of 5 must stay a limit of
     * 5, no matter which direction the clock moved.
     */
    it("mints no tokens when the clock goes backwards", async () => {
      const key = `${runId}:rl-backwards`;
      let clock = 3_000_000;
      const bucket = new RedisTokenBucket(
        client,
        { capacity: 5, refillPerSecond: 1, keyPrefix: key },
        () => new Date(clock),
      );

      // Drain it at the later instant.
      for (let i = 0; i < 5; i += 1) expect((await bucket.take("k")).allowed).toBe(true);
      expect((await bucket.take("k")).allowed).toBe(false);

      // The clock steps back a full minute — 60 tokens' worth of refill.
      clock -= 60_000;

      const admitted = [];
      for (let i = 0; i < 10; i += 1) admitted.push((await bucket.take("k")).allowed);
      expect(admitted.filter(Boolean)).toEqual([]);

      // And time moving FORWARD again must still not pay out the rewind.
      clock += 2_000;
      expect((await bucket.take("k")).allowed).toBe(true);
      expect((await bucket.take("k")).allowed).toBe(true);
      expect((await bucket.take("k")).allowed).toBe(false);
    });

    it("sets a TTL on the bucket key, so abandoned buckets do not accumulate", async () => {
      const bucket = new RedisTokenBucket(client, {
        capacity: 5,
        refillPerSecond: 1,
        ttlSeconds: 120,
        keyPrefix: `${runId}:rl-ttl`,
      });
      await bucket.take("k");
      const ttl = await client.send(["TTL", `${runId}:rl-ttl:k`]);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(120);
    });
  });

  describe("capacity semaphore", () => {
    it("grants exactly 3 of 10 concurrent acquires", async () => {
      const sem = new RedisSemaphore(client, { capacity: 3, leaseMs: 30_000, keyPrefix: `${runId}:sem` });
      const results = await Promise.all(Array.from({ length: 10 }, () => sem.acquire("sandbox")));
      expect(results.filter((r) => r.granted).length).toBe(3);
      expect(await sem.holders("sandbox")).toBe(3);
    });

    it("releases the permit of a crashed holder when its lease runs out", async () => {
      // A short lease so the test does not sleep for long. 1000ms is the floor
      // the constructor allows.
      const sem = new RedisSemaphore(client, { capacity: 1, leaseMs: 1_000, keyPrefix: `${runId}:sem-ttl` });
      expect((await sem.acquire("host")).granted).toBe(true);
      expect((await sem.acquire("host")).granted).toBe(false);

      // The holder "crashes": no release, no renew.
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect((await sem.acquire("host")).granted).toBe(true);
    });

    it("keeps a renewed permit alive past its original lease", async () => {
      const sem = new RedisSemaphore(client, { capacity: 1, leaseMs: 1_000, keyPrefix: `${runId}:sem-renew` });
      const result = await sem.acquire("host");
      if (!result.granted) throw new Error("expected a permit");
      for (let beat = 0; beat < 4; beat += 1) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(await sem.renew(result.permit)).toBe(true);
      }
      expect((await sem.acquire("host")).granted).toBe(false);
      expect(await sem.release(result.permit)).toBe(true);
    });

    /**
     * Renamed, because the old name credited the wrong line.
     *
     * It read "refuses to renew an expired permit (ZADD XX)", and it passed
     * with `XX` deleted — the flag was unreachable behind the `ZSCORE` guard,
     * so the test never exercised what its name claimed. What actually refuses
     * the resurrection is the sweep plus that guard, and that is what is named
     * and asserted here.
     */
    it("refuses to renew a permit whose lease expired, and leaves the successor alone", async () => {
      const key = `${runId}:sem-expired-renew`;
      let clock = 2_000_000;
      const sem = new RedisSemaphore(
        client,
        { capacity: 1, leaseMs: 1_000, keyPrefix: key },
        () => new Date(clock),
      );
      const first = await sem.acquire("host");
      if (!first.granted) throw new Error("expected a permit");

      clock += 5_000;
      const successor = await sem.acquire("host");
      expect(successor.granted).toBe(true);

      // The stalled holder comes back and tries to keep going.
      expect(await sem.renew(first.permit)).toBe(false);
      // Its renewal must not have re-added it beside the successor.
      expect(await sem.holders("host")).toBe(1);
      expect(await client.send(["ZCARD", `${key}:host`])).toBe(1);
      if (!successor.granted) throw new Error("unreachable");
      expect(await client.send(["ZSCORE", `${key}:host`, successor.permit.token])).not.toBeNull();
      expect(await client.send(["ZSCORE", `${key}:host`, first.permit.token])).toBeNull();
    });

    /**
     * The expired-holder sweep, pinned against the REAL Lua.
     *
     * `ZREMRANGEBYSCORE` at the top of the acquire script is what returns a
     * crashed holder's permit to the pool. The suite already had a test for
     * that, but it proved the permit came back after a real 1.2s sleep — and a
     * lease that has expired is ALSO gone from `ZCOUNT`, so the same green
     * appears whether the sweep ran or the member merely aged out of the count.
     * Deleting the sweep left the whole 168-test suite passing.
     *
     * This drives the clock instead of the wall, and asserts on the zset's
     * membership (`ZCARD`, which counts expired members too) rather than on a
     * live-holder gauge. Without the sweep the dead token is still a member,
     * `count >= capacity` holds, and the successor is refused — capacity that
     * never comes back.
     */
    it("sweeps an expired holder out of the zset, not merely out of the count", async () => {
      const key = `${runId}:sem-sweep`;
      let clock = 1_000_000;
      const sem = new RedisSemaphore(
        client,
        { capacity: 1, leaseMs: 1_000, keyPrefix: key },
        () => new Date(clock),
      );

      expect((await sem.acquire("host")).granted).toBe(true);
      expect(await client.send(["ZCARD", `${key}:host`])).toBe(1);

      // The holder crashes; time passes well beyond its lease.
      clock += 5_000;

      const successor = await sem.acquire("host");
      expect(successor.granted).toBe(true);
      // Exactly one member: the dead token was REMOVED, not just outscored.
      expect(await client.send(["ZCARD", `${key}:host`])).toBe(1);
    });

    it("never exceeds capacity under a churn of acquire/release", async () => {
      const sem = new RedisSemaphore(client, { capacity: 3, leaseMs: 30_000, keyPrefix: `${runId}:sem-churn` });
      let peak = 0;
      await Promise.all(
        Array.from({ length: 8 }, async () => {
          for (let round = 0; round < 4; round += 1) {
            const result = await sem.acquire("k");
            if (!result.granted) continue;
            peak = Math.max(peak, await sem.holders("k"));
            await sem.release(result.permit);
          }
        }),
      );
      expect(peak).toBeLessThanOrEqual(3);
      expect(await sem.holders("k")).toBe(0);
    });
  });

  describe("distributed lock", () => {
    it("gives the lock to exactly one of 50 racing callers", async () => {
      const lock = new RedisLock(client, { ttlMs: 30_000, keyPrefix: `${runId}:lock` });
      const handles = await Promise.all(Array.from({ length: 50 }, () => lock.tryAcquire("chain")));
      expect(handles.filter((handle) => handle !== null).length).toBe(1);
    });

    it("does not delete a successor's lock after its own expired", async () => {
      const lock = new RedisLock(client, { ttlMs: 1_000, keyPrefix: `${runId}:lock-fence` });
      const first = await lock.tryAcquire("k");
      if (first === null) throw new Error("expected the lock");
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      const second = await lock.tryAcquire("k");
      expect(second).not.toBeNull();
      expect(await lock.release(first)).toBe(false);
      expect(await lock.tryAcquire("k")).toBeNull();
      if (second !== null) expect(await lock.release(second)).toBe(true);
    });

    it("serialises a critical section across concurrent callers", async () => {
      const lock = new RedisLock(client, { ttlMs: 10_000, keyPrefix: `${runId}:lock-crit` });
      let counter = 0;
      await Promise.all(
        Array.from({ length: 15 }, () =>
          lock.withLock(
            "k",
            async () => {
              const seen = counter;
              await new Promise((resolve) => setTimeout(resolve, 2));
              counter = seen + 1;
            },
            { waitMs: 10_000 },
          ),
        ),
      );
      expect(counter).toBe(15);
    });
  });

  describe("cache", () => {
    it("round-trips a value and honours its TTL", async () => {
      const cache = new RedisCache(client, { keyPrefix: `${runId}:cache`, defaultTtlSeconds: 60 });
      expect(await cache.get("k")).toBeNull();
      await cache.set("k", "value");
      expect(await cache.get("k")).toBe("value");
      const ttl = await cache.ttl("k");
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60);
      await cache.delete("k");
      expect(await cache.get("k")).toBeNull();
    });

    it("expires a short-lived entry for real", async () => {
      const cache = new RedisCache(client, { keyPrefix: `${runId}:cache-exp` });
      await cache.set("k", "v", 1);
      expect(await cache.get("k")).toBe("v");
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(await cache.get("k")).toBeNull();
    });

    it("stores a multi-byte value byte-exactly", async () => {
      const cache = new RedisCache(client, { keyPrefix: `${runId}:cache-utf8` });
      const value = "çağrı — kota doldu ✓";
      await cache.set("k", value, 60);
      expect(await cache.get("k")).toBe(value);
    });
  });

  describe("script cache recovery", () => {
    it("keeps working after SCRIPT FLUSH — the NOSCRIPT fallback is real", async () => {
      const bucket = new RedisTokenBucket(client, {
        capacity: 5,
        refillPerSecond: 0.001,
        keyPrefix: `${runId}:rl-flush`,
      });
      expect((await bucket.take("k")).allowed).toBe(true);
      // Exactly what a Redis restart or an operator's flush does to a client
      // holding a SHA. Without the fallback every later take would throw.
      await client.send(["SCRIPT", "FLUSH"]);
      expect((await bucket.take("k")).allowed).toBe(true);
    });
  });

  describe("mutation, against a real server", () => {
    /**
     * The same mutant as `mutation.test.ts`, run against real Redis.
     *
     * `mutation.test.ts` proves the FAKE client interleaves. This proves the
     * real one does too — that the Lua script is load-bearing on the wire and
     * not merely on a simulated store. Without it, somebody could reasonably
     * suspect the in-memory client's `await Promise.resolve()` was
     * manufacturing the race.
     */
    it("a split read/compute/write bucket over-admits on real Redis", async () => {
      const key = `${runId}:mutant`;
      const capacity = 10;

      const naiveTake = async (): Promise<boolean> => {
        const state = (await client.send(["HMGET", key, "t", "ts"])) as (string | null)[];
        const stored = state[0];
        let tokens = stored === null || stored === undefined ? capacity : Number(stored);
        const allowed = tokens >= 1;
        if (allowed) tokens -= 1;
        await client.send(["HSET", key, "t", String(tokens), "ts", String(Date.now())]);
        return allowed;
      };

      const results = await Promise.all(Array.from({ length: 100 }, () => naiveTake()));
      const allowed = results.filter(Boolean).length;
      // The atomic version answers exactly 10 for this same input, above.
      expect(allowed).toBeGreaterThan(capacity);
    });

    it("a split ZCARD/ZADD semaphore over-grants on real Redis", async () => {
      const key = `${runId}:mutant-sem`;
      const capacity = 3;
      const naiveAcquire = async (token: string): Promise<boolean> => {
        const count = (await client.send(["ZCARD", key])) as number;
        if (count >= capacity) return false;
        await client.send(["ZADD", key, String(Date.now() + 30_000), token]);
        return true;
      };
      const results = await Promise.all(
        Array.from({ length: 10 }, (_unused, index) => naiveAcquire(`t${index}`)),
      );
      expect(results.filter(Boolean).length).toBeGreaterThan(capacity);
    });
  });

  describe("client behaviour on the wire", () => {
    it("pipelines concurrent commands and matches every reply to its own caller", async () => {
      const replies = await Promise.all(
        Array.from({ length: 50 }, (_unused, index) => client.send(["ECHO", `payload-${index}`])),
      );
      expect(replies).toEqual(Array.from({ length: 50 }, (_unused, index) => `payload-${index}`));
    });

    it("surfaces a server error as a RedisCommandError without killing the connection", async () => {
      await expect(client.send(["INCR", `${runId}:not-a-number-holder`, "extra", "args"])).rejects.toThrow(
        /redis INCR/,
      );
      expect(await client.send(["PING"])).toBe("PONG");
    });
  });
});
