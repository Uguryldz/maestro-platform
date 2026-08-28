import { z } from "zod";
import { parseRedisUrl, type RedisClient, type RedisConnectionOptions } from "./client.js";
import { CacheConfigError } from "./errors.js";
import { FakeRedisClient } from "./fake-client.js";
import { createRedisClient } from "./socket-client.js";

/**
 * Turning configuration into a client.
 *
 * `@maestro/config`'s `EnvSchema` owns `REDIS_URL` and is the source of truth
 * for it; this module reads the validated value and decides what to build. The
 * decision itself belongs to the composition root, which is why `buildCoordination`
 * takes an explicit mode rather than sniffing `NODE_ENV` — a deployment that
 * silently fell back to in-memory coordination in production would be a rate
 * limiter that does not limit, discovered by a provider's bill.
 */

export const CacheModeSchema = z.enum(["redis", "memory"]);
export type CacheMode = z.infer<typeof CacheModeSchema>;

export interface CoordinationOptions {
  readonly mode: CacheMode;
  /** Required when mode is "redis". */
  readonly url?: string | undefined;
  readonly connection?: Partial<Omit<RedisConnectionOptions, "host" | "port">>;
  /** Refuses "memory" outright. The prod profile sets this. */
  readonly requireDistributed?: boolean;
}

export interface Coordination {
  readonly client: RedisClient;
  readonly mode: CacheMode;
  /** True when coordination really is shared between processes. */
  readonly distributed: boolean;
}

/**
 * Build the client the primitives run on.
 *
 * The `memory` mode is a real, supported configuration — a developer laptop
 * running one BFF, one worker and no container stack — and not a degraded
 * fallback. It is only correct BECAUSE it is single-process, so it is chosen
 * explicitly and `distributed` reports what the caller actually got. A boot
 * banner that printed "rate limiting: on" for both would be the whole problem
 * in one line.
 */
export function buildCoordination(options: CoordinationOptions): Coordination {
  const mode = CacheModeSchema.parse(options.mode);
  if (mode === "memory") {
    if (options.requireDistributed === true) {
      throw new CacheConfigError(
        'coordination mode "memory" is single-process and cannot bound a multi-replica deployment — ' +
          "set REDIS_URL and use mode \"redis\" (M4/M19)",
      );
    }
    return { client: new FakeRedisClient(), mode, distributed: false };
  }
  if (options.url === undefined || options.url.trim() === "") {
    throw new CacheConfigError('coordination mode "redis" needs REDIS_URL');
  }
  // Parsed here so a malformed URL fails at boot, in front of an operator,
  // rather than at the first rate-limit check hours later (M6 fail-closed).
  parseRedisUrl(options.url, options.connection);
  return { client: createRedisClient(options.url, options.connection ?? {}), mode, distributed: true };
}

/**
 * The mode a deployment should use, given what it was configured with.
 *
 * A production deployment with no `REDIS_URL` is refused rather than defaulted:
 * that is a bank running unbounded LLM spend and unbounded sandbox capacity
 * because a variable was forgotten.
 */
export function resolveCacheMode(env: { REDIS_URL?: string | undefined; NODE_ENV: string }): CacheMode {
  if (env.REDIS_URL !== undefined && env.REDIS_URL.trim() !== "") return "redis";
  if (env.NODE_ENV === "production") {
    throw new CacheConfigError(
      "REDIS_URL is required in production — without it the token bucket and the capacity " +
        "semaphore are process-local and every replica gets a full allowance (M4/M19)",
    );
  }
  return "memory";
}
