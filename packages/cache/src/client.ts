import { CacheConfigError } from "./errors.js";
import type { RespValue } from "./resp.js";

/**
 * The seam every primitive in this package is written against.
 *
 * It is deliberately one method wide. A token bucket does not need pipelines,
 * pub/sub or cluster routing — it needs "send these argv, give me the reply",
 * and narrowing the surface to that is what lets the concurrency tests run
 * against an in-memory fake AND against a real server without a branch in the
 * primitives themselves.
 *
 * `send` is a single logical command. Anything that must be atomic is one EVAL,
 * never two sends — see `scripts.ts` for why that is the whole point.
 */
export interface RedisClient {
  send(args: readonly (string | number)[]): Promise<RespValue>;
  /** Idempotent. Safe to call on an already-closed client. */
  close(): Promise<void>;
}

export interface RedisConnectionOptions {
  readonly host: string;
  readonly port: number;
  /** From `redis://user:pass@host` or `REDIS_PASSWORD`. Never logged. */
  readonly password?: string;
  readonly username?: string;
  /** Logical database index (`redis://host:6379/3`). */
  readonly db: number;
  readonly tls: boolean;
  /** Per-command deadline. A hung coordination call is a stalled workflow. */
  readonly commandTimeoutMs: number;
  readonly connectTimeoutMs: number;
  /**
   * Reconnect attempts before `send` gives up and throws.
   *
   * Bounded on purpose. An unbounded retry loop inside a rate limiter turns a
   * Redis outage into a pile of workflow activities blocked forever, which
   * Temporal cannot distinguish from slow work. Failing after a few seconds
   * lets the activity's own retry policy — which has visibility and a budget —
   * take over.
   */
  readonly maxReconnectAttempts: number;
  readonly reconnectBaseDelayMs: number;
  readonly reconnectMaxDelayMs: number;
}

export const DEFAULT_CONNECTION: Omit<RedisConnectionOptions, "host" | "port"> = {
  db: 0,
  tls: false,
  commandTimeoutMs: 5_000,
  connectTimeoutMs: 5_000,
  maxReconnectAttempts: 5,
  reconnectBaseDelayMs: 50,
  reconnectMaxDelayMs: 2_000,
};

/**
 * Parse a `redis://` / `rediss://` URL into connection options.
 *
 * The password is extracted here and never re-serialised: `endpoint()` below
 * is what error messages and log lines use, and it is host:port only. A
 * connection error that printed the URL it failed on would put a Redis
 * password into a bank's log aggregator (M80).
 */
export function parseRedisUrl(
  url: string,
  overrides: Partial<Omit<RedisConnectionOptions, "host" | "port">> = {},
): RedisConnectionOptions {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CacheConfigError(`REDIS_URL is not a URL (expected redis://host:port)`);
  }
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
    throw new CacheConfigError(`REDIS_URL scheme "${parsed.protocol}" is not redis: or rediss:`);
  }
  if (parsed.hostname === "") throw new CacheConfigError("REDIS_URL has no host");

  const dbText = parsed.pathname.replace(/^\//, "");
  const db = dbText === "" ? 0 : Number(dbText);
  if (!Number.isInteger(db) || db < 0) {
    throw new CacheConfigError(`REDIS_URL database index "${dbText}" is not a non-negative integer`);
  }

  return {
    ...DEFAULT_CONNECTION,
    ...overrides,
    host: parsed.hostname,
    port: parsed.port === "" ? 6379 : Number(parsed.port),
    db,
    tls: parsed.protocol === "rediss:",
    // `decodeURIComponent`: a password with a `@` or `/` must be percent-encoded
    // in the URL, and passing the encoded form to AUTH would fail to
    // authenticate with a message that blames the credential rather than the
    // encoding.
    ...(parsed.password === "" ? {} : { password: decodeURIComponent(parsed.password) }),
    ...(parsed.username === "" ? {} : { username: decodeURIComponent(parsed.username) }),
  };
}

/** Host and port only — safe to put in an error message or a log line. */
export function endpoint(options: Pick<RedisConnectionOptions, "host" | "port">): string {
  return `${options.host}:${options.port}`;
}
