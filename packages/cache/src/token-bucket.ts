import type { RedisClient } from "./client.js";
import { CacheConfigError } from "./errors.js";
import { expectIntegerArray } from "./resp.js";
import { ScriptRunner } from "./script-runner.js";
import { TOKEN_BUCKET_LUA } from "./scripts.js";

/**
 * Cross-process token bucket (M19).
 *
 * `@maestro/llm-gateway`'s `TokenBucket` is correct and stays where it is — for
 * ONE process. Its state is a field, so two BFF replicas each get the full
 * allowance and the provider sees double the configured rate. That is the bug
 * this class fixes, and it fixes it in the only place it can be fixed: in
 * shared state, mutated atomically.
 *
 * The two are interchangeable at the call site by design (`take()` → wait
 * milliseconds), so the composition root picks one and no caller branches.
 */

export interface TokenBucketOptions {
  /** Burst size. A bucket at capacity admits this many calls instantly. */
  readonly capacity: number;
  readonly refillPerSecond: number;
  /**
   * How long an untouched bucket survives. Must comfortably exceed a full
   * refill (`capacity / refillPerSecond`), or a bucket could expire while
   * partly drained and come back full — a rate limit that resets itself under
   * exactly the intermittent traffic it is meant to shape.
   */
  readonly ttlSeconds?: number;
  /** Namespace prefix, so one Redis can serve several environments. */
  readonly keyPrefix?: string;
}

export interface TakeResult {
  readonly allowed: boolean;
  /** Milliseconds to wait before the bucket would admit this cost. 0 if allowed. */
  readonly waitMs: number;
  /** Tokens left after the call, to three decimals. Diagnostics and tests. */
  readonly remaining: number;
}

export class RedisTokenBucket {
  readonly #script: ScriptRunner;
  readonly #prefix: string;
  readonly #ttlSeconds: number;

  constructor(
    private readonly client: RedisClient,
    private readonly options: TokenBucketOptions,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!(options.capacity > 0)) throw new CacheConfigError("token bucket capacity must be > 0");
    if (!(options.refillPerSecond > 0)) {
      // A bucket that never refills is a one-shot quota wearing a rate
      // limiter's name; the script would divide by zero computing the wait.
      throw new CacheConfigError("token bucket refillPerSecond must be > 0 (use a semaphore for a fixed budget)");
    }
    this.#script = new ScriptRunner(client, TOKEN_BUCKET_LUA);
    this.#prefix = options.keyPrefix ?? "maestro:rl";
    this.#ttlSeconds =
      options.ttlSeconds ?? Math.max(60, Math.ceil((options.capacity / options.refillPerSecond) * 2));
  }

  /**
   * Charge `cost` tokens against `key`.
   *
   * One round trip, one atomic script. There is no read-then-write here and
   * there must never be: the whole limit is that the decision and the debit
   * happen with nothing in between.
   */
  async take(key: string, cost = 1): Promise<TakeResult> {
    if (!(cost > 0)) throw new CacheConfigError("token bucket cost must be > 0");
    if (cost > this.options.capacity) {
      // Otherwise the caller waits forever for a bucket that can never hold
      // enough — a hang, reported as a configuration error instead.
      throw new CacheConfigError(
        `token bucket cost ${cost} exceeds capacity ${this.options.capacity}: this call can never be admitted`,
      );
    }
    const reply = await this.#script.run(
      [`${this.#prefix}:${key}`],
      [this.options.capacity, this.options.refillPerSecond, this.now().getTime(), cost, this.#ttlSeconds],
    );
    const [allowed = 0, waitMs = 0, milliTokens = 0] = expectIntegerArray(reply, "token-bucket");
    return { allowed: allowed === 1, waitMs, remaining: milliTokens / 1000 };
  }

  /**
   * Take a token, waiting as long as it takes.
   *
   * The loop re-takes rather than trusting the first `waitMs`, because between
   * the wait and the retry another process may have drained the bucket again.
   * `maxWaitMs` bounds the total: an unbounded wait inside an activity is
   * indistinguishable from a hang.
   */
  async takeBlocking(key: string, options: { cost?: number; maxWaitMs?: number } = {}): Promise<TakeResult> {
    const cost = options.cost ?? 1;
    const deadline = this.now().getTime() + (options.maxWaitMs ?? 30_000);
    for (;;) {
      const result = await this.take(key, cost);
      if (result.allowed) return result;
      const remainingBudget = deadline - this.now().getTime();
      if (remainingBudget <= 0 || result.waitMs > remainingBudget) return result;
      await sleep(Math.max(1, result.waitMs));
    }
  }

  /** Current tokens without charging any — for a status screen, never for a decision. */
  async peek(key: string): Promise<number> {
    const reply = await this.client.send(["HGET", `${this.#prefix}:${key}`, "t"]);
    if (typeof reply !== "string") return this.options.capacity;
    const tokens = Number(reply);
    return Number.isFinite(tokens) ? tokens : this.options.capacity;
  }

  async reset(key: string): Promise<void> {
    await this.client.send(["DEL", `${this.#prefix}:${key}`]);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}
