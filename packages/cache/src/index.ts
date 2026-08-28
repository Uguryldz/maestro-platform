/**
 * `@maestro/cache` — cross-process coordination (M4, M19).
 *
 * Four primitives that all answer the same question: what happens when the
 * platform is more than one process?
 *
 *   RedisTokenBucket  atomic rate limit (M19) — the fix for a per-process
 *                     `TokenBucket` that gives every replica a full allowance
 *   RedisSemaphore    bounded concurrency with a lease, so a crashed holder's
 *                     permit comes back on its own
 *   RedisLock         mutual exclusion for the idempotency guard and the audit chain
 *   RedisCache        TTL'd key/value — the M4 cache layer
 *
 * Name: `cache` rather than `redis` because the package is named for what it
 * provides, not for the technology behind it — the same reason `@maestro/storage`
 * is not called `s3` while containing an S3 driver. `RedisClient` is the seam,
 * `SocketRedisClient` and `FakeRedisClient` are the two implementations, and
 * `cache` is the catalog prefix M4's UI already uses.
 *
 * M44: only the composition root imports this package. Nothing under
 * `packages/*` that is a core domain package may — it opens a socket.
 */
export * from "./cache.js";
export * from "./client.js";
export * from "./config.js";
export * from "./errors.js";
export * from "./fake-client.js";
export * from "./lock.js";
export * from "./lua-sim.js";
export * from "./memory-store.js";
export * from "./resp.js";
export * from "./script-runner.js";
export * from "./scripts.js";
export * from "./semaphore.js";
export * from "./socket-client.js";
export * from "./token-bucket.js";
