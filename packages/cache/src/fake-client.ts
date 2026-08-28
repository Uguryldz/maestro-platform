import { createHash } from "node:crypto";
import type { RedisClient } from "./client.js";
import { RedisCommandError } from "./errors.js";
import { evalLua } from "./lua-sim.js";
import { MemoryStore, type StoredValue } from "./memory-store.js";
import type { RespValue } from "./resp.js";

/**
 * An in-memory RedisClient for tests and for the dev profile.
 *
 * It exists for two reasons that pull in the same direction. Tests need the
 * suite to run with no container and no network; the dev profile needs a
 * single-process developer machine to boot without Redis at all. Both get the
 * same object, which means the code path a developer exercises is the one the
 * tests cover.
 *
 * The important property is that it is NOT a correctness shortcut. `send`
 * awaits a microtask before touching state, so a caller that does
 * `Promise.all` of a hundred takes really does interleave — and the primitives
 * still have to be atomic to pass. `evalLua` is what provides that atomicity:
 * one script runs to completion in one synchronous block, exactly as Redis
 * runs it. `test/mutation.test.ts` proves the fake is discriminating by
 * splitting a script into three sends and watching those same assertions fail.
 *
 * Where it is honestly weaker than Redis is coverage, not semantics: only the
 * verbs this package uses are implemented, and it is one process. That is why
 * `test/redis-integration.test.ts` runs the identical scenarios against a real
 * server and asserts the same numbers.
 */
export class FakeRedisClient implements RedisClient {
  readonly #data = new MemoryStore();
  readonly #scripts = new Map<string, string>();
  #closed = false;
  /** Every command, in the order the fake served it — the ScriptRunner tests read this. */
  readonly commandLog: string[] = [];
  /** Set to make the next N commands throw, to exercise fail-open/fail-closed. */
  failNext = 0;

  /** The backing store, so a test can assert on keys directly. */
  get store(): Map<string, StoredValue> {
    return this.#data.store;
  }

  /** Simulated clock. Advance it to expire keys without sleeping. */
  get now(): number {
    return this.#data.now;
  }

  set now(value: number) {
    this.#data.now = value;
  }

  async send(args: readonly (string | number)[]): Promise<RespValue> {
    if (this.#closed) throw new RedisCommandError("send", "client is closed");
    // The await is load-bearing. Without it `send` would be synchronous in
    // practice and a `Promise.all` of takes would run one after another, so a
    // non-atomic implementation would pass the concurrency test.
    await Promise.resolve();
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new RedisCommandError(String(args[0] ?? ""), "injected failure");
    }
    const name = String(args[0] ?? "").toUpperCase();
    this.commandLog.push(name);
    return this.#execute(name, args.slice(1).map(String));
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.resolve();
  }

  /** The data verbs, synchronously — the seam `lua-sim` mirrors run against. */
  command(name: string, args: string[]): RespValue {
    return this.#data.command(name, args);
  }

  #execute(name: string, args: string[]): RespValue {
    switch (name) {
      case "PING":
        return "PONG";
      case "EVAL":
        return this.#eval(args[0] ?? "", args.slice(1));
      case "EVALSHA": {
        const body = this.#scripts.get((args[0] ?? "").toLowerCase());
        // Mirrors a real server that has never seen the SHA (or was flushed),
        // so `ScriptRunner`'s fallback is exercised rather than assumed.
        if (body === undefined) throw new RedisCommandError("EVALSHA", "NOSCRIPT No matching script");
        return this.#eval(body, args.slice(1));
      }
      case "SCRIPT":
        return this.#script(args);
      default:
        return this.#data.command(name, args);
    }
  }

  #script(args: string[]): RespValue {
    const subcommand = (args[0] ?? "").toUpperCase();
    if (subcommand === "LOAD") return this.#load(args[1] ?? "");
    if (subcommand === "FLUSH") {
      this.#scripts.clear();
      return "OK";
    }
    throw new RedisCommandError("SCRIPT", `ERR unsupported subcommand ${args[0] ?? ""}`);
  }

  #eval(body: string, tail: string[]): RespValue {
    this.#load(body);
    const keyCount = Number(tail[0] ?? 0);
    return evalLua(body, tail.slice(1, 1 + keyCount), tail.slice(1 + keyCount), this.#data);
  }

  #load(body: string): string {
    const sha = createHash("sha1").update(body, "utf8").digest("hex");
    this.#scripts.set(sha, body);
    return sha;
  }
}
