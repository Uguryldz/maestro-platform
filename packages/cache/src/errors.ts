/**
 * Coordination-layer errors (M4).
 *
 * Every failure mode here is explicit for one reason: this package exists to
 * stop two processes from disagreeing, and a coordination primitive that
 * degrades silently is worse than one that is absent. A rate limiter that
 * "allows on error" is not a rate limiter; a semaphore that hands out a permit
 * it could not record is not a semaphore. So the drivers throw, and the caller
 * decides — the one place a fail-open is legal is `RedisCache.get`, where a
 * miss and an outage are genuinely the same answer to the caller (recompute).
 */

/** The connection could not be established, or was lost mid-command. */
export class RedisConnectionError extends Error {
  constructor(
    readonly endpoint: string,
    cause: string,
  ) {
    super(`redis ${endpoint}: ${cause}`);
    this.name = "RedisConnectionError";
  }
}

/** The server answered `-ERR ...`. Carries the server's own text verbatim. */
export class RedisCommandError extends Error {
  constructor(
    readonly command: string,
    readonly reply: string,
  ) {
    super(`redis ${command}: ${reply}`);
    this.name = "RedisCommandError";
  }
}

/** A command did not answer within its deadline. */
export class RedisTimeoutError extends Error {
  constructor(
    readonly command: string,
    readonly timeoutMs: number,
  ) {
    super(`redis ${command}: no reply within ${timeoutMs}ms`);
    this.name = "RedisTimeoutError";
  }
}

/** The reply was well-formed RESP but not the shape the caller demanded. */
export class RedisProtocolError extends Error {
  constructor(detail: string) {
    super(`redis protocol: ${detail}`);
    this.name = "RedisProtocolError";
  }
}

/**
 * A configuration value this package cannot work around — an unusable
 * `REDIS_URL`, a semaphore with capacity zero, a bucket that never refills.
 */
export class CacheConfigError extends Error {
  constructor(detail: string) {
    super(`cache: ${detail}`);
    this.name = "CacheConfigError";
  }
}

/**
 * `release` was called with a token the semaphore does not hold.
 *
 * This is not pedantry. The usual cause is a holder whose TTL expired — the
 * semaphore already reclaimed its permit and possibly handed it to somebody
 * else, so the late releaser must NOT decrement the count again. Reporting it
 * lets the caller notice that its work outran its lease, which is a real bug
 * with a real remedy (renew, or raise the TTL).
 */
export class PermitNotHeldError extends Error {
  constructor(
    readonly key: string,
    readonly token: string,
  ) {
    super(
      `cache: semaphore "${key}" does not hold permit ${token} — it expired and was reclaimed, ` +
        `or it was already released`,
    );
    this.name = "PermitNotHeldError";
  }
}
