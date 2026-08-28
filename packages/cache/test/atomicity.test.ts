import { describe, expect, it } from "vitest";
import { FakeRedisClient } from "../src/fake-client.js";
import { RedisLock } from "../src/lock.js";
import { RedisSemaphore } from "../src/semaphore.js";
import { RedisTokenBucket } from "../src/token-bucket.js";

/**
 * The suite this package exists for.
 *
 * Every test here launches its calls with `Promise.all` and never awaits one
 * before starting the next. That is what makes them race: `FakeRedisClient.send`
 * awaits a microtask before touching state, so a hundred pending takes really do
 * interleave, and any primitive that reads, decides and writes in three separate
 * `send` calls will hand out more permits than it has.
 *
 * `mutation.test.ts` proves that is not a hypothetical — it splits the scripts
 * into three commands and asserts these very numbers go wrong.
 */

const bucketFor = (capacity: number, refillPerSecond = 1): { bucket: RedisTokenBucket; client: FakeRedisClient } => {
  const client = new FakeRedisClient();
  const bucket = new RedisTokenBucket(client, { capacity, refillPerSecond }, () => new Date(client.now));
  return { bucket, client };
};

describe("token bucket under concurrency (M19)", () => {
  it("admits exactly the capacity when 100 requests race for 10 tokens", async () => {
    const { bucket } = bucketFor(10, 0.001); // refill so slow it cannot matter
    // No await inside the loop: all 100 are in flight before any completes.
    const results = await Promise.all(Array.from({ length: 100 }, () => bucket.take("llm:openai")));
    const allowed = results.filter((result) => result.allowed).length;
    expect(allowed).toBe(10);
    expect(results.length - allowed).toBe(90);
  });

  it("is exact at every capacity, not just the round one", async () => {
    for (const capacity of [1, 3, 7, 25]) {
      const { bucket } = bucketFor(capacity, 0.001);
      const results = await Promise.all(Array.from({ length: 100 }, () => bucket.take("k")));
      expect(results.filter((r) => r.allowed).length).toBe(capacity);
    }
  });

  it("keeps separate keys separate while they race against each other", async () => {
    const { bucket } = bucketFor(5, 0.001);
    const calls = Array.from({ length: 60 }, (_unused, index) => bucket.take(`driver-${index % 3}`));
    const results = await Promise.all(calls);
    // Three independent buckets of 5 — not one bucket of 15, and not 15 of 5.
    expect(results.filter((r) => r.allowed).length).toBe(15);
  });

  it("never lets the token count go negative, whatever the interleaving", async () => {
    const { bucket } = bucketFor(4, 0.001);
    const results = await Promise.all(Array.from({ length: 50 }, () => bucket.take("k")));
    expect(Math.min(...results.map((r) => r.remaining))).toBeGreaterThanOrEqual(0);
  });

  it("charges a multi-token cost atomically — 20 racing takes of 3 fit 4 times in 12", async () => {
    const { bucket } = bucketFor(12, 0.001);
    const results = await Promise.all(Array.from({ length: 20 }, () => bucket.take("k", 3)));
    expect(results.filter((r) => r.allowed).length).toBe(4);
  });

  it("refills over time and then re-limits exactly", async () => {
    const { bucket, client } = bucketFor(10, 5);
    expect((await Promise.all(Array.from({ length: 30 }, () => bucket.take("k")))).filter((r) => r.allowed).length)
      .toBe(10);
    client.now += 1_000; // 5 tokens back
    const second = await Promise.all(Array.from({ length: 30 }, () => bucket.take("k")));
    expect(second.filter((r) => r.allowed).length).toBe(5);
  });

  it("reports a wait that is actually long enough to succeed", async () => {
    const { bucket, client } = bucketFor(1, 2); // one token every 500ms
    expect((await bucket.take("k")).allowed).toBe(true);
    const refused = await bucket.take("k");
    expect(refused.allowed).toBe(false);
    expect(refused.waitMs).toBe(500);
    client.now += refused.waitMs;
    expect((await bucket.take("k")).allowed).toBe(true);
  });

  it("does not mint tokens when the clock steps backwards", async () => {
    const { bucket, client } = bucketFor(5, 10);
    await Promise.all(Array.from({ length: 5 }, () => bucket.take("k")));
    client.now -= 60_000; // NTP step
    expect((await bucket.take("k")).allowed).toBe(false);
  });
});

describe("capacity semaphore under concurrency", () => {
  const semaphoreFor = (capacity: number): { sem: RedisSemaphore; client: FakeRedisClient } => {
    const client = new FakeRedisClient();
    let counter = 0;
    const sem = new RedisSemaphore(
      client,
      { capacity, leaseMs: 30_000 },
      () => new Date(client.now),
      () => `token-${(counter += 1)}`,
    );
    return { sem, client };
  };

  it("grants exactly 3 permits when 10 racing callers ask for capacity 3", async () => {
    const { sem } = semaphoreFor(3);
    const results = await Promise.all(Array.from({ length: 10 }, () => sem.acquire("sandbox")));
    expect(results.filter((r) => r.granted).length).toBe(3);
    expect(await sem.holders("sandbox")).toBe(3);
  });

  it("never exceeds capacity while holders acquire and release concurrently", async () => {
    const { sem } = semaphoreFor(3);
    let live = 0;
    let peak = 0;

    // 10 concurrent workers, each taking a permit, "working", releasing.
    await Promise.all(
      Array.from({ length: 10 }, async () => {
        for (let round = 0; round < 5; round += 1) {
          const result = await sem.acquire("sandbox");
          if (!result.granted) {
            await new Promise((resolve) => setTimeout(resolve, 1));
            continue;
          }
          live += 1;
          peak = Math.max(peak, live);
          // Yield so another worker can observe the count mid-hold.
          await new Promise((resolve) => setTimeout(resolve, 1));
          live -= 1;
          await sem.release(result.permit);
        }
      }),
    );

    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // the test would be vacuous if nothing overlapped
    expect(await sem.holders("sandbox")).toBe(0);
  });

  it("frees the permits again once every holder releases", async () => {
    const { sem } = semaphoreFor(3);
    const granted = (await Promise.all(Array.from({ length: 10 }, () => sem.acquire("sandbox"))))
      .filter((r): r is { granted: true; permit: { token: string; key: string; expiresAt: Date; holders: number } } =>
        r.granted,
      );
    await Promise.all(granted.map((r) => sem.release(r.permit)));
    expect(await sem.holders("sandbox")).toBe(0);
    const again = await Promise.all(Array.from({ length: 10 }, () => sem.acquire("sandbox")));
    expect(again.filter((r) => r.granted).length).toBe(3);
  });

  it("keeps separate semaphore keys independent under a racing load", async () => {
    const { sem } = semaphoreFor(2);
    const results = await Promise.all(
      Array.from({ length: 30 }, (_unused, index) => sem.acquire(`host-${index % 3}`)),
    );
    expect(results.filter((r) => r.granted).length).toBe(6); // 3 keys × 2
  });
});

describe("semaphore lease expiry (a crashed holder must not leak its permit)", () => {
  const build = (capacity: number, leaseMs: number): { sem: RedisSemaphore; client: FakeRedisClient } => {
    const client = new FakeRedisClient();
    let counter = 0;
    const sem = new RedisSemaphore(
      client,
      { capacity, leaseMs },
      () => new Date(client.now),
      () => `token-${(counter += 1)}`,
    );
    return { sem, client };
  };

  it("reclaims the permit of a holder that never released", async () => {
    const { sem, client } = build(2, 5_000);
    // Two holders take the whole semaphore and then "crash" — no release.
    expect((await sem.acquire("sandbox")).granted).toBe(true);
    expect((await sem.acquire("sandbox")).granted).toBe(true);
    expect((await sem.acquire("sandbox")).granted).toBe(false);

    client.now += 5_001; // both leases run out
    const afterExpiry = await sem.acquire("sandbox");
    expect(afterExpiry.granted).toBe(true);
    expect(await sem.holders("sandbox")).toBe(1);
  });

  it("holds the permit for exactly the lease and not a millisecond less", async () => {
    const { sem, client } = build(1, 5_000);
    expect((await sem.acquire("k")).granted).toBe(true);
    client.now += 4_999;
    expect((await sem.acquire("k")).granted).toBe(false);
    client.now += 2;
    expect((await sem.acquire("k")).granted).toBe(true);
  });

  it("renews a live permit, so a long job keeps its slot", async () => {
    const { sem, client } = build(1, 5_000);
    const result = await sem.acquire("k");
    if (!result.granted) throw new Error("expected a permit");

    for (let beat = 0; beat < 10; beat += 1) {
      client.now += 2_000;
      expect(await sem.renew(result.permit)).toBe(true);
    }
    // 20 seconds of a 5-second lease later, the permit is still exclusive.
    expect((await sem.acquire("k")).granted).toBe(false);
  });

  it("refuses to renew a permit that already expired, rather than resurrecting it", async () => {
    // The `ZADD XX` flag. Without it a stalled holder would re-create a permit
    // the semaphore has already handed to somebody else.
    const { sem, client } = build(1, 5_000);
    const first = await sem.acquire("k");
    if (!first.granted) throw new Error("expected a permit");

    client.now += 5_001;
    const successor = await sem.acquire("k");
    expect(successor.granted).toBe(true);

    expect(await sem.renew(first.permit)).toBe(false);
    expect(await sem.holders("k")).toBe(1); // the successor's, not two
  });

  it("reports a release of an expired permit as false instead of double-decrementing", async () => {
    const { sem, client } = build(2, 5_000);
    const first = await sem.acquire("k");
    if (!first.granted) throw new Error("expected a permit");
    client.now += 5_001;
    const successor = await sem.acquire("k");
    expect(successor.granted).toBe(true);

    expect(await sem.release(first.permit)).toBe(false);
    expect(await sem.holders("k")).toBe(1); // the late release did not touch it
  });

  it("treats a re-acquire with the same token as a renewal, never a second permit", async () => {
    const client = new FakeRedisClient();
    const sem = new RedisSemaphore(client, { capacity: 2, leaseMs: 5_000 }, () => new Date(client.now), () => "fixed");
    const first = await sem.acquire("k");
    const second = await sem.acquire("k");
    expect(first.granted && second.granted).toBe(true);
    expect(await sem.holders("k")).toBe(1);
  });
});

describe("distributed lock under concurrency", () => {
  const lockFor = (): { lock: RedisLock; client: FakeRedisClient } => {
    const client = new FakeRedisClient();
    let counter = 0;
    const lock = new RedisLock(
      client,
      { ttlMs: 30_000 },
      () => new Date(client.now),
      () => `holder-${(counter += 1)}`,
    );
    return { lock, client };
  };

  it("gives the lock to exactly one of 50 racing callers", async () => {
    const { lock } = lockFor();
    const handles = await Promise.all(Array.from({ length: 50 }, () => lock.tryAcquire("audit:chain")));
    expect(handles.filter((handle) => handle !== null).length).toBe(1);
  });

  it("serialises a critical section — 20 concurrent increments land as 20", async () => {
    const { lock } = lockFor();
    let counter = 0;
    await Promise.all(
      Array.from({ length: 20 }, () =>
        lock.withLock("chain", async () => {
          // A read-modify-write with an await in the middle: without the lock,
          // every caller reads the same value and the total collapses.
          const seen = counter;
          await new Promise((resolve) => setTimeout(resolve, 1));
          counter = seen + 1;
        }),
      ),
    );
    expect(counter).toBe(20);
  });

  it("does not let a stale holder delete its successor's lock", async () => {
    const client = new FakeRedisClient();
    let counter = 0;
    const lock = new RedisLock(client, { ttlMs: 1_000 }, () => new Date(client.now), () => `holder-${(counter += 1)}`);

    const first = await lock.tryAcquire("k");
    if (first === null) throw new Error("expected the lock");
    client.now += 1_001; // first holder's lock expired
    const second = await lock.tryAcquire("k");
    expect(second).not.toBeNull();

    // The stale holder now runs its `finally`. The token comparison saves us.
    expect(await lock.release(first)).toBe(false);
    expect(await lock.tryAcquire("k")).toBeNull(); // the successor still holds it
  });

  it("reports 'somebody else has it' as a refusal rather than an exception", async () => {
    const { lock } = lockFor();
    const held = await lock.tryAcquire("k");
    expect(held).not.toBeNull();
    const outcome = await lock.withLock("k", async () => "ran", { waitMs: 0 });
    expect(outcome).toEqual({ ran: false });
  });
});
