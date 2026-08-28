import { createHash } from "node:crypto";
import type { RedisClient } from "./client.js";
import { RedisCommandError } from "./errors.js";
import type { RespValue } from "./resp.js";

/**
 * Runs a Lua script by SHA, falling back to the full body on NOSCRIPT.
 *
 * `EVALSHA` sends 40 bytes instead of the script; `EVAL` sends the whole thing
 * every time. At the call rate a token bucket sees, that difference is the
 * difference between a rate limiter and a bandwidth problem.
 *
 * The NOSCRIPT fallback is not an optimisation, it is required for correctness:
 * Redis's script cache is not persisted, so a restart, a failover to a replica
 * that never saw the script, or an operator's `SCRIPT FLUSH` all leave a client
 * holding a SHA the server has forgotten. A client that only sent EVALSHA would
 * start failing every rate-limit check after a routine Redis restart. The SHA is
 * computed locally rather than taken from `SCRIPT LOAD` so the first call needs
 * one round trip, not two.
 */
export class ScriptRunner {
  readonly #sha: string;

  constructor(
    private readonly client: RedisClient,
    private readonly body: string,
  ) {
    this.#sha = createHash("sha1").update(body, "utf8").digest("hex");
  }

  get sha(): string {
    return this.#sha;
  }

  async run(keys: readonly string[], argv: readonly (string | number)[]): Promise<RespValue> {
    const tail = [keys.length, ...keys, ...argv];
    try {
      return await this.client.send(["EVALSHA", this.#sha, ...tail]);
    } catch (error) {
      if (!isNoScript(error)) throw error;
      // EVAL both runs the script and caches it under the same SHA, so the
      // next call is back on the fast path without an explicit SCRIPT LOAD.
      return await this.client.send(["EVAL", this.body, ...tail]);
    }
  }
}

function isNoScript(error: unknown): boolean {
  return error instanceof RedisCommandError && error.reply.startsWith("NOSCRIPT");
}
