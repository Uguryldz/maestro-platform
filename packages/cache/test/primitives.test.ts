import { describe, expect, it, vi } from "vitest";
import { CacheConfigError, PermitNotHeldError } from "../src/errors.js";
import { FakeRedisClient } from "../src/fake-client.js";
import { RedisLock } from "../src/lock.js";
import { RedisSemaphore } from "../src/semaphore.js";
import { RedisTokenBucket } from "../src/token-bucket.js";

/**
 * Configuration guards and the wrapper helpers. The concurrency behaviour these
 * primitives exist for lives in `atomicity.test.ts`; this file covers the
 * arguments that must be refused and the ergonomics built on top.
 */

describe("RedisTokenBucket configuration", () => {
  const client = (): FakeRedisClient => new FakeRedisClient();

  it("refuses a capacity of zero or less", () => {
    expect(() => new RedisTokenBucket(client(), { capacity: 0, refillPerSecond: 1 })).toThrow(CacheConfigError);
    expect(() => new RedisTokenBucket(client(), { capacity: -1, refillPerSecond: 1 })).toThrow(/capacity must be > 0/);
  });

  it("refuses a bucket that never refills, rather than dividing by zero in the script", () => {
    expect(() => new RedisTokenBucket(client(), { capacity: 5, refillPerSecond: 0 })).toThrow(
      /refillPerSecond must be > 0/,
    );
  });

  it("refuses a cost larger than the capacity instead of waiting forever", async () => {
    // Otherwise the caller blocks on a bucket that can never hold enough.
    const bucket = new RedisTokenBucket(client(), { capacity: 5, refillPerSecond: 1 });
    await expect(bucket.take("k", 6)).rejects.toThrow(/can never be admitted/);
    await expect(bucket.take("k", 0)).rejects.toThrow(/cost must be > 0/);
  });

  it("derives a TTL that outlasts a full refill", async () => {
    // 100 tokens at 1/s takes 100s to refill. A 60s TTL would let a partly
    // drained bucket expire and come back FULL — a rate limit that removes
    // itself under exactly the intermittent traffic it is meant to shape.
    const fake = client();
    const bucket = new RedisTokenBucket(fake, { capacity: 100, refillPerSecond: 1 }, () => new Date(fake.now));
    await bucket.take("k");
    const ttlSeconds = (fake.command("TTL", ["maestro:rl:k"]) as number) ?? 0;
    expect(ttlSeconds).toBeGreaterThanOrEqual(100 / 1);
  });

  it("honours an explicit TTL over the derived one", async () => {
    const fake = client();
    const bucket = new RedisTokenBucket(
      fake,
      { capacity: 10, refillPerSecond: 1, ttlSeconds: 3_600 },
      () => new Date(fake.now),
    );
    await bucket.take("k");
    expect(fake.command("TTL", ["maestro:rl:k"])).toBe(3_600);
  });

  it("resets a bucket back to full", async () => {
    const fake = client();
    const bucket = new RedisTokenBucket(fake, { capacity: 3, refillPerSecond: 0.001 }, () => new Date(fake.now));
    await Promise.all([bucket.take("k"), bucket.take("k"), bucket.take("k")]);
    expect((await bucket.take("k")).allowed).toBe(false);
    await bucket.reset("k");
    expect((await bucket.take("k")).allowed).toBe(true);
  });

  it("peeks without charging a token", async () => {
    const fake = client();
    const bucket = new RedisTokenBucket(fake, { capacity: 5, refillPerSecond: 0.001 }, () => new Date(fake.now));
    expect(await bucket.peek("k")).toBe(5); // untouched bucket reads as full
    await bucket.take("k");
    expect(await bucket.peek("k")).toBeCloseTo(4, 5);
    expect(await bucket.peek("k")).toBeCloseTo(4, 5); // peeking again changed nothing
  });

  it("blocks until a token is free, then succeeds", async () => {
    const fake = client();
    const bucket = new RedisTokenBucket(fake, { capacity: 1, refillPerSecond: 50 }, () => new Date(Date.now()));
    expect((await bucket.take("k")).allowed).toBe(true);
    const result = await bucket.takeBlocking("k", { maxWaitMs: 2_000 });
    expect(result.allowed).toBe(true);
  });

  it("gives up blocking once its budget is spent rather than waiting forever", async () => {
    const fake = client();
    const bucket = new RedisTokenBucket(fake, { capacity: 1, refillPerSecond: 0.001 }, () => new Date(Date.now()));
    await bucket.take("k");
    const result = await bucket.takeBlocking("k", { maxWaitMs: 20 });
    expect(result.allowed).toBe(false);
  });
});

describe("RedisSemaphore configuration", () => {
  it("refuses a capacity that is not a positive integer", () => {
    const client = new FakeRedisClient();
    expect(() => new RedisSemaphore(client, { capacity: 0 })).toThrow(CacheConfigError);
    expect(() => new RedisSemaphore(client, { capacity: 1.5 })).toThrow(/integer >= 1/);
  });

  it("refuses a lease short enough that ordinary jitter would revoke live holders", () => {
    const client = new FakeRedisClient();
    expect(() => new RedisSemaphore(client, { capacity: 1, leaseMs: 100 })).toThrow(/leaseMs must be >= 1000/);
  });

  it("defaults to a 30-second lease", () => {
    expect(new RedisSemaphore(new FakeRedisClient(), { capacity: 1 }).leaseMs).toBe(30_000);
  });
});

describe("RedisSemaphore.hold", () => {
  const build = (capacity: number): { sem: RedisSemaphore; client: FakeRedisClient } => {
    const client = new FakeRedisClient();
    let counter = 0;
    const sem = new RedisSemaphore(
      client,
      { capacity, leaseMs: 5_000 },
      () => new Date(client.now),
      () => `token-${(counter += 1)}`,
    );
    return { sem, client };
  };

  it("runs the body holding a permit and releases it afterwards", async () => {
    const { sem } = build(1);
    const seen = await sem.hold("k", async (permit) => {
      expect(await sem.holders("k")).toBe(1);
      return permit.token;
    });
    expect(seen).toBe("token-1");
    expect(await sem.holders("k")).toBe(0);
  });

  it("releases the permit even when the body throws", async () => {
    const { sem } = build(1);
    await expect(sem.hold("k", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    // A permit stranded by a failure would shrink capacity on every error.
    expect(await sem.holders("k")).toBe(0);
  });

  it("refuses when no capacity is free rather than queueing silently", async () => {
    const { sem } = build(1);
    await sem.acquire("k");
    await expect(sem.hold("k", async () => "never")).rejects.toThrow(PermitNotHeldError);
  });

  it("does not let two bodies run at once beyond the capacity", async () => {
    const { sem } = build(2);
    let live = 0;
    let peak = 0;
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        sem.hold("k", async () => {
          live += 1;
          peak = Math.max(peak, live);
          await new Promise((resolve) => setTimeout(resolve, 5));
          live -= 1;
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(2);
    expect(attempts.filter((a) => a.status === "fulfilled").length).toBe(2);
  });
});

describe("RedisLock configuration and helpers", () => {
  it("refuses a TTL too short to survive a round trip", () => {
    expect(() => new RedisLock(new FakeRedisClient(), { ttlMs: 10 })).toThrow(/ttlMs must be >= 100/);
  });

  it("renews its own lock and reports a lost one", async () => {
    const client = new FakeRedisClient();
    let counter = 0;
    const lock = new RedisLock(client, { ttlMs: 1_000 }, () => new Date(client.now), () => `h${(counter += 1)}`);
    const handle = await lock.tryAcquire("k");
    if (handle === null) throw new Error("expected the lock");
    client.now += 500;
    expect(await lock.renew(handle)).toBe(true);
    client.now += 1_001;
    expect(await lock.renew(handle)).toBe(false);
  });

  it("waits for a busy lock and takes it once it is released", async () => {
    const client = new FakeRedisClient();
    let counter = 0;
    const lock = new RedisLock(client, { ttlMs: 5_000 }, () => new Date(Date.now()), () => `h${(counter += 1)}`);
    const held = await lock.tryAcquire("k");
    if (held === null) throw new Error("expected the lock");

    const waiting = lock.acquire("k", { waitMs: 2_000, pollMs: 5 });
    setTimeout(() => void lock.release(held), 20);
    expect(await waiting).not.toBeNull();
  });

  it("returns null rather than throwing when the wait runs out", async () => {
    const client = new FakeRedisClient();
    const lock = new RedisLock(client, { ttlMs: 5_000 }, () => new Date(Date.now()));
    await lock.tryAcquire("k");
    expect(await lock.acquire("k", { waitMs: 20, pollMs: 5 })).toBeNull();
  });

  it("releases the lock even when the body throws", async () => {
    const client = new FakeRedisClient();
    const lock = new RedisLock(client, { ttlMs: 5_000 });
    await expect(lock.withLock("k", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await lock.tryAcquire("k")).not.toBeNull();
  });

  it("does not mask the body's error with a release failure", async () => {
    const client = new FakeRedisClient();
    const lock = new RedisLock(client, { ttlMs: 5_000 });
    const failing = vi.fn(async () => {
      client.failNext = 5; // the release will not get through
      throw new Error("the real problem");
    });
    await expect(lock.withLock("k", failing)).rejects.toThrow("the real problem");
  });
});
