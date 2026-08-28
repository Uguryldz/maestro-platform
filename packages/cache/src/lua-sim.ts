import { RedisCommandError } from "./errors.js";
import type { RespValue } from "./resp.js";
import {
  LOCK_RELEASE_LUA,
  LOCK_RENEW_LUA,
  SEMAPHORE_ACQUIRE_LUA,
  SEMAPHORE_RELEASE_LUA,
  SEMAPHORE_RENEW_LUA,
  TOKEN_BUCKET_LUA,
} from "./scripts.js";

/**
 * TypeScript mirrors of the Lua scripts, for the in-memory client.
 *
 * A real Lua interpreter is not on the table (`fengari` is 400 KB of
 * dependency for a test double), so each script is re-implemented here. The
 * hazard that creates is obvious — two implementations that can disagree — and
 * it is handled three ways rather than hoped away:
 *
 *  1. Lookup is by exact script body. Edit a `.lua` string in `scripts.ts`
 *     without updating its mirror and every fake-backed test throws
 *     `no mirror for this script`, loudly, at once.
 *  2. Each mirror runs SYNCHRONOUSLY through `client.command`, so it has the
 *     same all-or-nothing property the real script has. That is what the
 *     concurrency tests actually measure.
 *  3. `test/redis-integration.test.ts` runs the same scenarios against a real
 *     server. Agreement between the two is asserted, not assumed.
 *
 * Each mirror is a line-by-line transliteration on purpose. Where the Lua does
 * `math.floor(tokens * 1000)`, so does this — a "cleaner" formulation is a
 * behavioural difference waiting to be discovered in production.
 */

/** The store operations a mirror is allowed to use — the same seam RESP uses. */
export interface LuaHost {
  command(name: string, args: string[]): RespValue;
}

type Mirror = (keys: string[], argv: string[], host: LuaHost) => RespValue;

export function evalLua(body: string, keys: string[], argv: string[], host: LuaHost): RespValue {
  const mirror = MIRRORS.get(body);
  if (mirror === undefined) {
    throw new RedisCommandError(
      "EVAL",
      "ERR the in-memory client has no mirror for this script — add one in lua-sim.ts " +
        "(a script and its mirror must be edited together)",
    );
  }
  return mirror(keys, argv, host);
}

const tokenBucket: Mirror = (keys, argv, host) => {
  const key = keys[0] ?? "";
  const capacity = Number(argv[0]);
  const refill = Number(argv[1]);
  const now = Number(argv[2]);
  const cost = Number(argv[3]);
  const ttl = Number(argv[4]);

  const state = host.command("HMGET", [key, "t", "ts"]) as (string | null)[];
  let tokens = state[0] === null || state[0] === undefined ? NaN : Number(state[0]);
  let last = state[1] === null || state[1] === undefined ? NaN : Number(state[1]);
  if (!Number.isFinite(tokens) || !Number.isFinite(last)) {
    tokens = capacity;
    last = now;
  }

  let elapsed = now - last;
  if (elapsed < 0) elapsed = 0;
  tokens = Math.min(capacity, tokens + (elapsed / 1000) * refill);

  let allowed = 0;
  let wait = 0;
  if (tokens >= cost) {
    tokens -= cost;
    allowed = 1;
  } else {
    wait = Math.ceil(((cost - tokens) / refill) * 1000);
  }

  host.command("HSET", [key, "t", String(tokens), "ts", String(now)]);
  host.command("EXPIRE", [key, String(ttl)]);
  return [allowed, wait, Math.floor(tokens * 1000)];
};

const semaphoreAcquire: Mirror = (keys, argv, host) => {
  const key = keys[0] ?? "";
  const now = Number(argv[0]);
  const capacity = Number(argv[1]);
  const token = argv[2] ?? "";
  const leaseMs = Number(argv[3]);

  host.command("ZREMRANGEBYSCORE", [key, "-inf", String(now)]);

  const held = host.command("ZSCORE", [key, token]);
  if (held !== null) {
    const expiry = now + leaseMs;
    host.command("ZADD", [key, String(expiry), token]);
    host.command("PEXPIRE", [key, String(leaseMs)]);
    return [1, host.command("ZCARD", [key]) as number, expiry];
  }

  const count = host.command("ZCARD", [key]) as number;
  if (count >= capacity) return [0, count, 0];

  const expiry = now + leaseMs;
  host.command("ZADD", [key, String(expiry), token]);
  host.command("PEXPIRE", [key, String(leaseMs)]);
  return [1, count + 1, expiry];
};

const semaphoreRelease: Mirror = (keys, argv, host) => {
  const key = keys[0] ?? "";
  const removed = host.command("ZREM", [key, argv[0] ?? ""]) as number;
  return [removed, host.command("ZCARD", [key]) as number];
};

const semaphoreRenew: Mirror = (keys, argv, host) => {
  const key = keys[0] ?? "";
  const now = Number(argv[0]);
  const token = argv[1] ?? "";
  const leaseMs = Number(argv[2]);

  host.command("ZREMRANGEBYSCORE", [key, "-inf", String(now)]);
  // The sweep above is what refuses an expired permit; see SEMAPHORE_RENEW_LUA.
  if (host.command("ZSCORE", [key, token]) === null) return [0, 0];
  const expiry = now + leaseMs;
  host.command("ZADD", [key, String(expiry), token]);
  host.command("PEXPIRE", [key, String(leaseMs)]);
  return [1, expiry];
};

const lockRelease: Mirror = (keys, argv, host) => {
  if (host.command("GET", [keys[0] ?? ""]) === (argv[0] ?? "")) {
    return host.command("DEL", [keys[0] ?? ""]);
  }
  return 0;
};

const lockRenew: Mirror = (keys, argv, host) => {
  if (host.command("GET", [keys[0] ?? ""]) === (argv[0] ?? "")) {
    return host.command("PEXPIRE", [keys[0] ?? "", argv[1] ?? "0"]);
  }
  return 0;
};

const MIRRORS = new Map<string, Mirror>([
  [TOKEN_BUCKET_LUA, tokenBucket],
  [SEMAPHORE_ACQUIRE_LUA, semaphoreAcquire],
  [SEMAPHORE_RELEASE_LUA, semaphoreRelease],
  [SEMAPHORE_RENEW_LUA, semaphoreRenew],
  [LOCK_RELEASE_LUA, lockRelease],
  [LOCK_RENEW_LUA, lockRenew],
]);

/** The script bodies that have a mirror — `test/lua-sim.test.ts` pins the set. */
export function mirroredScripts(): string[] {
  return [...MIRRORS.keys()];
}
