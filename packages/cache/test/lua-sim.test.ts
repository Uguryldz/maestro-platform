import { describe, expect, it } from "vitest";
import { evalLua, mirroredScripts } from "../src/lua-sim.js";
import { FakeRedisClient } from "../src/fake-client.js";
import { RedisCommandError } from "../src/errors.js";
import {
  LOCK_RELEASE_LUA,
  LOCK_RENEW_LUA,
  SEMAPHORE_ACQUIRE_LUA,
  SEMAPHORE_RELEASE_LUA,
  SEMAPHORE_RENEW_LUA,
  TOKEN_BUCKET_LUA,
} from "../src/scripts.js";

/**
 * The guard on the fake client's weakest point.
 *
 * `lua-sim.ts` re-implements each Lua script in TypeScript, which means two
 * implementations that can drift apart. These tests make drift loud: the mirror
 * set is pinned against the script set, and lookup is by exact body, so editing
 * a script without editing its mirror turns every fake-backed test red at once
 * rather than letting the suite pass against logic production never runs.
 */

const ALL_SCRIPTS = [
  TOKEN_BUCKET_LUA,
  SEMAPHORE_ACQUIRE_LUA,
  SEMAPHORE_RELEASE_LUA,
  SEMAPHORE_RENEW_LUA,
  LOCK_RELEASE_LUA,
  LOCK_RENEW_LUA,
];

describe("every script has a mirror", () => {
  it("mirrors exactly the scripts this package ships — no more, no fewer", () => {
    expect(new Set(mirroredScripts())).toEqual(new Set(ALL_SCRIPTS));
    expect(mirroredScripts().length).toBe(ALL_SCRIPTS.length);
  });

  it.each([
    ["token bucket", TOKEN_BUCKET_LUA],
    ["semaphore acquire", SEMAPHORE_ACQUIRE_LUA],
    ["semaphore release", SEMAPHORE_RELEASE_LUA],
    ["semaphore renew", SEMAPHORE_RENEW_LUA],
    ["lock release", LOCK_RELEASE_LUA],
    ["lock renew", LOCK_RENEW_LUA],
  ])("%s resolves to a mirror", (_name, body) => {
    expect(() => evalLua(body, ["k"], ["1", "1", "0", "1", "60"], new FakeRedisClient())).not.toThrow(
      /no mirror/,
    );
  });

  it("refuses a script it has never seen, instead of silently doing nothing", () => {
    // This is the failure a developer must see the moment they edit a script
    // and forget its mirror.
    expect(() => evalLua("return 1", [], [], new FakeRedisClient())).toThrow(RedisCommandError);
    expect(() => evalLua("return 1", [], [], new FakeRedisClient())).toThrow(/no mirror for this script/);
  });

  it("treats a whitespace-level edit as a different script", () => {
    // Lookup by exact body is what makes the guard work; a fuzzy match would
    // let a real logic change slip through onto a stale mirror.
    expect(() => evalLua(`${TOKEN_BUCKET_LUA} `, ["k"], ["1", "1", "0", "1", "60"], new FakeRedisClient())).toThrow(
      /no mirror/,
    );
  });
});

describe("the mirrors return the shapes the primitives narrow", () => {
  it("token bucket returns {allowed, waitMs, milliTokens}", () => {
    const client = new FakeRedisClient();
    const reply = evalLua(TOKEN_BUCKET_LUA, ["b"], ["10", "1", "0", "1", "60"], client);
    expect(reply).toEqual([1, 0, 9_000]);
  });

  it("token bucket reports a refusal with a positive wait and no tokens", () => {
    const client = new FakeRedisClient();
    evalLua(TOKEN_BUCKET_LUA, ["b"], ["1", "2", "0", "1", "60"], client);
    expect(evalLua(TOKEN_BUCKET_LUA, ["b"], ["1", "2", "0", "1", "60"], client)).toEqual([0, 500, 0]);
  });

  it("semaphore acquire returns {granted, holders, expiresAt}", () => {
    const client = new FakeRedisClient();
    expect(evalLua(SEMAPHORE_ACQUIRE_LUA, ["s"], ["0", "2", "tok-a", "5000"], client)).toEqual([1, 1, 5_000]);
    expect(evalLua(SEMAPHORE_ACQUIRE_LUA, ["s"], ["0", "2", "tok-b", "5000"], client)).toEqual([1, 2, 5_000]);
    expect(evalLua(SEMAPHORE_ACQUIRE_LUA, ["s"], ["0", "2", "tok-c", "5000"], client)).toEqual([0, 2, 0]);
  });

  it("semaphore release returns {removed, holders}", () => {
    const client = new FakeRedisClient();
    evalLua(SEMAPHORE_ACQUIRE_LUA, ["s"], ["0", "2", "tok-a", "5000"], client);
    expect(evalLua(SEMAPHORE_RELEASE_LUA, ["s"], ["tok-a"], client)).toEqual([1, 0]);
    expect(evalLua(SEMAPHORE_RELEASE_LUA, ["s"], ["tok-a"], client)).toEqual([0, 0]);
  });

  it("semaphore renew refuses a token that is not present", () => {
    const client = new FakeRedisClient();
    expect(evalLua(SEMAPHORE_RENEW_LUA, ["s"], ["0", "ghost", "5000"], client)).toEqual([0, 0]);
  });

  it("lock release returns 1 only for the owning token", () => {
    const client = new FakeRedisClient();
    client.command("SET", ["l", "mine"]);
    expect(evalLua(LOCK_RELEASE_LUA, ["l"], ["theirs"], client)).toBe(0);
    expect(evalLua(LOCK_RELEASE_LUA, ["l"], ["mine"], client)).toBe(1);
  });

  it("lock renew extends only the owning token", () => {
    const client = new FakeRedisClient();
    client.command("SET", ["l", "mine", "PX", "1000"]);
    expect(evalLua(LOCK_RENEW_LUA, ["l"], ["theirs", "5000"], client)).toBe(0);
    expect(evalLua(LOCK_RENEW_LUA, ["l"], ["mine", "5000"], client)).toBe(1);
    expect(client.command("PTTL", ["l"])).toBe(5_000);
  });
});

describe("the in-memory store behaves like Redis where the scripts depend on it", () => {
  it("answers ZSCORE with null for an absent member, which the scripts compare against", () => {
    const client = new FakeRedisClient();
    expect(client.command("ZSCORE", ["s", "nobody"])).toBeNull();
  });

  it("expires keys lazily, on the next look — as Redis does", () => {
    const client = new FakeRedisClient();
    client.command("SET", ["k", "v", "PX", "100"]);
    expect(client.command("GET", ["k"])).toBe("v");
    client.now += 101;
    expect(client.command("GET", ["k"])).toBeNull();
  });

  it("reports TTL as -2 for an absent key and -1 for one with no expiry", () => {
    const client = new FakeRedisClient();
    expect(client.command("PTTL", ["absent"])).toBe(-2);
    client.command("SET", ["k", "v"]);
    expect(client.command("PTTL", ["k"])).toBe(-1);
  });

  it("honours SET NX and SET XX the way the lock relies on", () => {
    const client = new FakeRedisClient();
    expect(client.command("SET", ["k", "a", "NX", "PX", "1000"])).toBe("OK");
    expect(client.command("SET", ["k", "b", "NX", "PX", "1000"])).toBeNull();
    expect(client.command("GET", ["k"])).toBe("a");
    expect(client.command("SET", ["absent", "v", "XX"])).toBeNull();
  });

  it("honours ZADD XX, which is what stops an expired permit resurrecting", () => {
    const client = new FakeRedisClient();
    client.command("ZADD", ["s", "XX", "100", "ghost"]);
    expect(client.command("ZCARD", ["s"])).toBe(0);
  });

  it("removes a zset key once its last member goes, rather than leaving an empty set", () => {
    const client = new FakeRedisClient();
    client.command("ZADD", ["s", "100", "a"]);
    client.command("ZREM", ["s", "a"]);
    expect(client.store.has("s")).toBe(false);
  });

  it("refuses a command it does not implement instead of answering nil", () => {
    // A fake that silently answered nil to an unimplemented verb would make a
    // primitive using it look correct in tests and fail in production.
    const client = new FakeRedisClient();
    expect(() => client.command("SETRANGE", ["k", "0", "v"])).toThrow(/unknown command/);
  });

  it("refuses a type-confused operation, as a real server would", () => {
    const client = new FakeRedisClient();
    client.command("SET", ["k", "v"]);
    expect(() => client.command("ZADD", ["k", "1", "m"])).toThrow(/WRONGTYPE/);
  });
});
