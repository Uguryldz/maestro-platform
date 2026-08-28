import { RedisCommandError } from "./errors.js";
import type { RespValue } from "./resp.js";

/**
 * The data verbs, in memory.
 *
 * Split from `FakeRedisClient` so that the client is about the PROTOCOL —
 * command dispatch, script cache, the microtask that makes concurrency real —
 * and this is about the STORE. The split matters for `lua-sim.ts`: a mirror
 * runs against this object directly, so a script's view of the store is
 * byte-for-byte the same one a plain command sees. Two separate code paths
 * would be two places for a semantic to drift.
 *
 * Only the verbs this package actually sends are implemented, and an
 * unimplemented one THROWS. A fake that answered nil to an unknown command
 * would let a primitive built on it look correct in tests and fail in
 * production, which is the one failure a test double must not enable.
 *
 * `now` is a plain field the caller advances. Nothing here reads the wall
 * clock, so a TTL test costs no real time and cannot flake on a slow machine.
 */

export type StoredValue =
  | { kind: "string"; value: string; expiresAt?: number }
  | { kind: "hash"; fields: Map<string, string>; expiresAt?: number }
  | { kind: "zset"; members: Map<string, number>; expiresAt?: number };

export class MemoryStore {
  readonly store = new Map<string, StoredValue>();
  /** Test hook: advanced by the caller, so expiries need no real sleeping. */
  now = 0;

  command(name: string, args: string[]): RespValue {
    this.#expire();
    const key = args[0] ?? "";
    switch (name) {
      case "GET": {
        const entry = this.store.get(key);
        return entry?.kind === "string" ? entry.value : null;
      }
      case "SET":
        return this.#set(key, args);
      case "DEL":
      case "UNLINK": {
        let removed = 0;
        for (const target of args) if (this.store.delete(target)) removed += 1;
        return removed;
      }
      case "EXISTS":
        return this.store.has(key) ? 1 : 0;
      case "ECHO":
        return args[0] ?? "";
      case "EXPIRE":
        return this.#setExpiry(key, Number(args[1] ?? 0) * 1_000);
      case "PEXPIRE":
        return this.#setExpiry(key, Number(args[1] ?? 0));
      case "TTL": {
        const ms = this.#pttl(key);
        return ms < 0 ? ms : Math.ceil(ms / 1_000);
      }
      case "PTTL":
        return this.#pttl(key);
      case "HSET":
        return this.#hset(key, args.slice(1));
      case "HGET": {
        const hash = this.#hash(key, false);
        return hash?.get(args[1] ?? "") ?? null;
      }
      case "HMGET": {
        const hash = this.#hash(key, false);
        return args.slice(1).map((field) => hash?.get(field) ?? null);
      }
      case "ZADD":
        return this.#zadd(key, args.slice(1));
      case "ZSCORE": {
        const score = this.#zset(key, false)?.get(args[1] ?? "");
        // A real server answers a null bulk string; `lua-sim` maps that to
        // Lua's `false`, which is what the semaphore scripts compare against.
        return score === undefined ? null : String(score);
      }
      case "ZCARD":
        return this.#zset(key, false)?.size ?? 0;
      case "ZREM": {
        const zset = this.#zset(key, false);
        if (zset === undefined) return 0;
        let removed = 0;
        for (const member of args.slice(1)) if (zset.delete(member)) removed += 1;
        if (zset.size === 0) this.store.delete(key);
        return removed;
      }
      case "ZCOUNT":
        return this.#zcount(key, args[1] ?? "-inf", args[2] ?? "+inf");
      case "ZREMRANGEBYSCORE":
        return this.#zremRange(key, args[1] ?? "-inf", args[2] ?? "+inf");
      default:
        throw new RedisCommandError(name, `ERR unknown command '${name}'`);
    }
  }

  #set(key: string, args: string[]): RespValue {
    const value = args[1] ?? "";
    const flags = args.slice(2).map((flag) => flag.toUpperCase());
    const existing = this.store.get(key);
    if (flags.includes("NX") && existing !== undefined) return null;
    if (flags.includes("XX") && existing === undefined) return null;
    let expiresAt: number | undefined;
    const px = flags.indexOf("PX");
    const ex = flags.indexOf("EX");
    if (px >= 0) expiresAt = this.now + Number(args[2 + px + 1] ?? 0);
    else if (ex >= 0) expiresAt = this.now + Number(args[2 + ex + 1] ?? 0) * 1_000;
    this.store.set(key, { kind: "string", value, ...(expiresAt === undefined ? {} : { expiresAt }) });
    return "OK";
  }

  #hset(key: string, pairs: string[]): number {
    const hash = this.#hash(key, true);
    let added = 0;
    for (let index = 0; index + 1 < pairs.length; index += 2) {
      const field = pairs[index] ?? "";
      if (!hash.has(field)) added += 1;
      hash.set(field, pairs[index + 1] ?? "");
    }
    return added;
  }

  #zadd(key: string, args: string[]): number {
    const flags: string[] = [];
    let cursor = 0;
    while (cursor < args.length && ["NX", "XX", "GT", "LT", "CH"].includes((args[cursor] ?? "").toUpperCase())) {
      flags.push((args[cursor] ?? "").toUpperCase());
      cursor += 1;
    }
    const zset = this.#zset(key, true);
    let added = 0;
    for (; cursor + 1 < args.length; cursor += 2) {
      const member = args[cursor + 1] ?? "";
      const present = zset.has(member);
      // `XX` is load-bearing for the semaphore: it refuses to re-create a
      // member that expired, so a stalled holder cannot resurrect a permit.
      if (flags.includes("NX") && present) continue;
      if (flags.includes("XX") && !present) continue;
      if (!present) added += 1;
      zset.set(member, Number(args[cursor] ?? 0));
    }
    if (zset.size === 0) this.store.delete(key);
    return added;
  }

  #zcount(key: string, min: string, max: string): number {
    const zset = this.#zset(key, false);
    if (zset === undefined) return 0;
    const low = boundary(min, -Infinity);
    const high = boundary(max, Infinity);
    let count = 0;
    for (const score of zset.values()) if (score >= low && score <= high) count += 1;
    return count;
  }

  #zremRange(key: string, min: string, max: string): number {
    const zset = this.#zset(key, false);
    if (zset === undefined) return 0;
    const low = boundary(min, -Infinity);
    const high = boundary(max, Infinity);
    let removed = 0;
    for (const [member, score] of [...zset]) {
      if (score >= low && score <= high) {
        zset.delete(member);
        removed += 1;
      }
    }
    if (zset.size === 0) this.store.delete(key);
    return removed;
  }

  #setExpiry(key: string, ms: number): number {
    const entry = this.store.get(key);
    if (entry === undefined) return 0;
    entry.expiresAt = this.now + ms;
    return 1;
  }

  #pttl(key: string): number {
    const entry = this.store.get(key);
    if (entry === undefined) return -2; // no such key
    if (entry.expiresAt === undefined) return -1; // exists, no expiry
    return Math.max(0, entry.expiresAt - this.now);
  }

  // Overloads so `create: true` narrows away the `undefined` — the callers
  // that create genuinely always get a map, and asserting that at each call
  // site with `!` would hide a real absence somewhere else.
  #hash(key: string, create: true): Map<string, string>;
  #hash(key: string, create: false): Map<string, string> | undefined;
  #hash(key: string, create: boolean): Map<string, string> | undefined {
    const entry = this.store.get(key);
    if (entry?.kind === "hash") return entry.fields;
    if (entry !== undefined) throw new RedisCommandError("HSET", WRONGTYPE);
    if (!create) return undefined;
    const fields = new Map<string, string>();
    this.store.set(key, { kind: "hash", fields });
    return fields;
  }

  #zset(key: string, create: true): Map<string, number>;
  #zset(key: string, create: false): Map<string, number> | undefined;
  #zset(key: string, create: boolean): Map<string, number> | undefined {
    const entry = this.store.get(key);
    if (entry?.kind === "zset") return entry.members;
    if (entry !== undefined) throw new RedisCommandError("ZADD", WRONGTYPE);
    if (!create) return undefined;
    const members = new Map<string, number>();
    this.store.set(key, { kind: "zset", members });
    return members;
  }

  /** Lazy expiry, exactly as Redis does it: a key is gone when it is next looked at. */
  #expire(): void {
    for (const [key, entry] of [...this.store]) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= this.now) this.store.delete(key);
    }
  }
}

const WRONGTYPE = "WRONGTYPE Operation against a key holding the wrong kind of value";

function boundary(text: string, fallback: number): number {
  if (text === "-inf") return -Infinity;
  if (text === "+inf" || text === "inf") return Infinity;
  const value = Number(text);
  return Number.isFinite(value) ? value : fallback;
}
