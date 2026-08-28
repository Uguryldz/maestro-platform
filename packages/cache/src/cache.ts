import type { RedisClient } from "./client.js";
import { CacheConfigError } from "./errors.js";

/**
 * TTL'd key/value cache (M4).
 *
 * The one primitive in this package that may fail OPEN, and the reason is
 * specific rather than convenient: to a caller, a cache miss and a cache
 * outage have the same correct response — compute the value. Turning an outage
 * into a throw would take a service that could still work, slowly, and stop it.
 *
 * That reasoning does NOT extend to the rate limiter, the semaphore or the
 * lock. There, failing open means exceeding a provider's rate limit, running
 * more sandboxes than the fleet can hold, or two workers writing the same audit
 * link. Those throw. The asymmetry is the point, and `failOpen` is scoped to
 * this class alone so it cannot be reached for elsewhere.
 *
 * Values are strings. Serialisation belongs to the caller: this cache must not
 * decide that a value is JSON, because the day one is not, the failure is a
 * parse error in a cache layer rather than a type error at the call site.
 */

export interface CacheOptions {
  readonly keyPrefix?: string;
  readonly defaultTtlSeconds?: number;
  /**
   * When true (the default), a Redis failure reads as a miss and a failed write
   * is dropped. Set false only where a stale read is worse than an outage.
   */
  readonly failOpen?: boolean;
  /** Called on a swallowed failure, so fail-open is observable rather than invisible. */
  readonly onError?: (operation: string, error: Error) => void;
}

const DEFAULT_TTL_SECONDS = 300;

export class RedisCache {
  readonly #prefix: string;
  readonly #ttl: number;
  readonly #failOpen: boolean;

  constructor(
    private readonly client: RedisClient,
    private readonly options: CacheOptions = {},
  ) {
    this.#ttl = options.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS;
    if (!Number.isInteger(this.#ttl) || this.#ttl < 1) {
      // A cache with no TTL is a memory leak with a lookup API: without an
      // expiry, every key ever written stays until Redis hits maxmemory and
      // starts evicting things the platform actually depends on.
      throw new CacheConfigError("cache defaultTtlSeconds must be an integer >= 1 — an unbounded cache never frees");
    }
    this.#prefix = options.keyPrefix ?? "maestro:cache";
    this.#failOpen = options.failOpen ?? true;
  }

  /** The value, or null for a miss (and, when failing open, for an outage). */
  async get(key: string): Promise<string | null> {
    try {
      const reply = await this.client.send(["GET", this.#key(key)]);
      return typeof reply === "string" ? reply : null;
    } catch (error) {
      return this.#swallow("get", error, null);
    }
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const ttl = ttlSeconds ?? this.#ttl;
    if (!Number.isInteger(ttl) || ttl < 1) throw new CacheConfigError("cache ttlSeconds must be an integer >= 1");
    try {
      await this.client.send(["SET", this.#key(key), value, "EX", ttl]);
    } catch (error) {
      this.#swallow("set", error, undefined);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(["DEL", this.#key(key)]);
    } catch (error) {
      this.#swallow("delete", error, undefined);
    }
  }

  async has(key: string): Promise<boolean> {
    try {
      return (await this.client.send(["EXISTS", this.#key(key)])) === 1;
    } catch (error) {
      return this.#swallow("has", error, false);
    }
  }

  /**
   * Read-through: return the cached value, or compute, store and return it.
   *
   * Deliberately NOT single-flight. Two concurrent misses both compute, and
   * that is the right trade for what this caches — prompt results and directory
   * lookups, where a duplicated computation is cheap. Making it single-flight
   * would mean taking a lock on every miss, which puts a Redis round trip and a
   * failure mode on the hot path of a cache whose entire job is to be faster
   * than the thing it fronts. A caller that genuinely cannot afford a duplicate
   * computation should use `RedisLock` explicitly, where the cost is visible.
   */
  async getOrSet(key: string, compute: () => Promise<string>, ttlSeconds?: number): Promise<string> {
    const hit = await this.get(key);
    if (hit !== null) return hit;
    const value = await compute();
    await this.set(key, value, ttlSeconds);
    return value;
  }

  /** Seconds until expiry; null when the key is absent or has no TTL. */
  async ttl(key: string): Promise<number | null> {
    try {
      const reply = await this.client.send(["TTL", this.#key(key)]);
      // -2 = no such key, -1 = key exists with no expiry. Neither is a duration.
      return typeof reply === "number" && reply >= 0 ? reply : null;
    } catch (error) {
      return this.#swallow("ttl", error, null);
    }
  }

  #swallow<T>(operation: string, error: unknown, fallback: T): T {
    if (!this.#failOpen) throw error;
    this.options.onError?.(operation, error as Error);
    return fallback;
  }

  #key(key: string): string {
    return `${this.#prefix}:${key}`;
  }
}
