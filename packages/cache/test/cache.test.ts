import { describe, expect, it, vi } from "vitest";
import { RedisCache } from "../src/cache.js";
import { CacheConfigError } from "../src/errors.js";
import { FakeRedisClient } from "../src/fake-client.js";
import { ScriptRunner } from "../src/script-runner.js";
import { TOKEN_BUCKET_LUA } from "../src/scripts.js";
import { RedisTokenBucket } from "../src/token-bucket.js";

describe("RedisCache", () => {
  it("round-trips a value under its prefix", async () => {
    const client = new FakeRedisClient();
    const cache = new RedisCache(client, { keyPrefix: "p" });
    await cache.set("k", "v");
    expect(await cache.get("k")).toBe("v");
    expect(client.store.has("p:k")).toBe(true);
  });

  it("reports a miss as null, not as an empty string", async () => {
    const cache = new RedisCache(new FakeRedisClient());
    expect(await cache.get("absent")).toBeNull();
  });

  it("distinguishes a stored empty string from a miss", async () => {
    const cache = new RedisCache(new FakeRedisClient());
    await cache.set("k", "");
    expect(await cache.get("k")).toBe("");
    expect(await cache.has("k")).toBe(true);
  });

  it("expires an entry once its TTL passes", async () => {
    const client = new FakeRedisClient();
    const cache = new RedisCache(client, { defaultTtlSeconds: 10 });
    await cache.set("k", "v");
    expect(await cache.get("k")).toBe("v");
    client.now += 10_001;
    expect(await cache.get("k")).toBeNull();
  });

  it("honours a per-call TTL over the default", async () => {
    const client = new FakeRedisClient();
    const cache = new RedisCache(client, { defaultTtlSeconds: 600 });
    await cache.set("short", "v", 5);
    client.now += 5_001;
    expect(await cache.get("short")).toBeNull();
  });

  it("refuses a cache configured with no expiry", async () => {
    // An unbounded cache is a memory leak with a lookup API.
    expect(() => new RedisCache(new FakeRedisClient(), { defaultTtlSeconds: 0 })).toThrow(CacheConfigError);
    const cache = new RedisCache(new FakeRedisClient());
    await expect(cache.set("k", "v", 0)).rejects.toThrow(CacheConfigError);
  });

  it("computes and stores on a miss, and returns the stored value on a hit", async () => {
    const cache = new RedisCache(new FakeRedisClient());
    const compute = vi.fn(async () => "computed");
    expect(await cache.getOrSet("k", compute)).toBe("computed");
    expect(await cache.getOrSet("k", compute)).toBe("computed");
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("reads an outage as a miss when failing open, and says so", async () => {
    const onError = vi.fn();
    const client = new FakeRedisClient();
    const cache = new RedisCache(client, { onError });
    client.failNext = 1;
    expect(await cache.get("k")).toBeNull();
    // Fail-open must be observable, or a permanently-down cache looks like a
    // permanently-cold one and nobody investigates.
    expect(onError).toHaveBeenCalledWith("get", expect.any(Error));
  });

  it("recomputes rather than failing when the cache is unavailable", async () => {
    const client = new FakeRedisClient();
    const cache = new RedisCache(client);
    client.failNext = 2; // the GET and the SET
    expect(await cache.getOrSet("k", async () => "fresh")).toBe("fresh");
  });

  it("propagates the failure when explicitly configured not to fail open", async () => {
    const client = new FakeRedisClient();
    const cache = new RedisCache(client, { failOpen: false });
    client.failNext = 1;
    await expect(cache.get("k")).rejects.toThrow(/injected failure/);
  });

  it("reports the remaining TTL, and null for a key with none", async () => {
    const client = new FakeRedisClient();
    const cache = new RedisCache(client, { defaultTtlSeconds: 60 });
    await cache.set("k", "v");
    expect(await cache.ttl("k")).toBe(60);
    expect(await cache.ttl("absent")).toBeNull();
  });
});

describe("fail-open is scoped to the cache alone", () => {
  it("the token bucket throws on an outage rather than admitting the call", async () => {
    // The asymmetry that matters: a cache that fails open costs a recompute, a
    // rate limiter that fails open costs a provider's rate limit.
    const client = new FakeRedisClient();
    const bucket = new RedisTokenBucket(client, { capacity: 10, refillPerSecond: 1 });
    client.failNext = 4; // EVALSHA + EVAL fallback, twice over
    await expect(bucket.take("k")).rejects.toThrow();
  });
});

describe("ScriptRunner", () => {
  it("computes the SHA locally, so the first call is one round trip", async () => {
    const client = new FakeRedisClient();
    const runner = new ScriptRunner(client, TOKEN_BUCKET_LUA);
    expect(runner.sha).toMatch(/^[0-9a-f]{40}$/);
    await runner.run(["k"], [10, 1, 0, 1, 60]);
    expect(client.commandLog[0]).toBe("EVALSHA");
  });

  it("falls back to EVAL on NOSCRIPT and then stays on the fast path", async () => {
    const client = new FakeRedisClient();
    const runner = new ScriptRunner(client, TOKEN_BUCKET_LUA);
    await runner.run(["k"], [10, 1, 0, 1, 60]);
    expect(client.commandLog).toEqual(["EVALSHA", "EVAL"]);

    client.commandLog.length = 0;
    await runner.run(["k"], [10, 1, 0, 1, 60]);
    // The EVAL cached the script under the same SHA, so no second fallback.
    expect(client.commandLog).toEqual(["EVALSHA"]);
  });

  it("recovers after a SCRIPT FLUSH, which is what a Redis restart looks like", async () => {
    const client = new FakeRedisClient();
    const runner = new ScriptRunner(client, TOKEN_BUCKET_LUA);
    await runner.run(["k"], [10, 1, 0, 1, 60]);
    await client.send(["SCRIPT", "FLUSH"]);
    client.commandLog.length = 0;
    await runner.run(["k"], [10, 1, 0, 1, 60]);
    expect(client.commandLog).toEqual(["SCRIPT", "EVALSHA", "EVAL"].slice(1));
  });

  it("does not retry a real command error as if it were a missing script", async () => {
    const client = new FakeRedisClient();
    const runner = new ScriptRunner(client, TOKEN_BUCKET_LUA);
    client.failNext = 1;
    await expect(runner.run(["k"], [10, 1, 0, 1, 60])).rejects.toThrow(/injected failure/);
  });
});
