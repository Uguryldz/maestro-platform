import { randomUUID } from "node:crypto";
import type { RedisClient } from "./client.js";
import { CacheConfigError } from "./errors.js";
import { expectInteger } from "./resp.js";
import { ScriptRunner } from "./script-runner.js";
import { LOCK_RELEASE_LUA, LOCK_RENEW_LUA } from "./scripts.js";

/**
 * Mutual exclusion across processes.
 *
 * The intended callers are the table-backed `IdempotencyGuard` (M33) — which
 * needs "only one worker runs this key's effect" — and the audit chain, whose
 * hash links must be appended by one writer at a time or the chain forks.
 *
 * Scope, stated plainly: this is a single-instance lock. It is safe when Redis
 * is a single node or a node with a replica that is NOT failed over to while
 * the lock is held. It is NOT a consensus protocol — if a failover promotes a
 * replica that had not yet received the SET, two holders exist. That is
 * acceptable for the two callers above because both are backed by a database
 * constraint (the idempotency table's unique key, the audit chain's previous-hash
 * check): the lock removes contention, the constraint provides correctness. Any
 * caller WITHOUT such a backstop must not treat this as sufficient.
 */

export interface LockOptions {
  /** How long the lock survives its holder's death. */
  readonly ttlMs?: number;
  readonly keyPrefix?: string;
}

export interface LockHandle {
  readonly key: string;
  /**
   * The fencing token. Release and renew both compare it, which is what stops
   * a process whose lock expired from deleting its successor's lock.
   */
  readonly token: string;
  readonly acquiredAt: Date;
}

const DEFAULT_TTL_MS = 10_000;

export class RedisLock {
  readonly #release: ScriptRunner;
  readonly #renew: ScriptRunner;
  readonly #prefix: string;
  readonly #ttlMs: number;

  constructor(
    private readonly client: RedisClient,
    options: LockOptions = {},
    private readonly now: () => Date = () => new Date(),
    private readonly newToken: () => string = () => randomUUID(),
  ) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (this.#ttlMs < 100) throw new CacheConfigError("lock ttlMs must be >= 100");
    this.#release = new ScriptRunner(client, LOCK_RELEASE_LUA);
    this.#renew = new ScriptRunner(client, LOCK_RENEW_LUA);
    this.#prefix = options.keyPrefix ?? "maestro:lock";
  }

  get ttlMs(): number {
    return this.#ttlMs;
  }

  /**
   * Try once. `SET key token NX PX ttl` is already atomic — a Lua script here
   * would add a round trip's worth of nothing.
   */
  async tryAcquire(key: string): Promise<LockHandle | null> {
    const token = this.newToken();
    const reply = await this.client.send(["SET", this.#key(key), token, "NX", "PX", this.#ttlMs]);
    // A refused SET NX answers with a null bulk string, not an error.
    if (reply === null) return null;
    return { key, token, acquiredAt: this.now() };
  }

  /**
   * Poll until the lock is free or the budget runs out.
   *
   * Jittered backoff, not a fixed interval: N workers that all lost the same
   * race would otherwise retry in lockstep forever, each round as contended as
   * the last.
   */
  async acquire(key: string, options: { waitMs?: number; pollMs?: number } = {}): Promise<LockHandle | null> {
    const deadline = this.now().getTime() + (options.waitMs ?? 5_000);
    const poll = options.pollMs ?? 25;
    for (;;) {
      const handle = await this.tryAcquire(key);
      if (handle !== null) return handle;
      if (this.now().getTime() >= deadline) return null;
      await sleep(poll + Math.floor(Math.random() * poll));
    }
  }

  /** Release only if still ours. False means the lock had expired. */
  async release(handle: LockHandle): Promise<boolean> {
    const reply = await this.#release.run([this.#key(handle.key)], [handle.token]);
    return expectInteger(reply, "lock-release") === 1;
  }

  /** Extend our own lock. False means it expired — the work is no longer protected. */
  async renew(handle: LockHandle): Promise<boolean> {
    const reply = await this.#renew.run([this.#key(handle.key)], [handle.token, this.#ttlMs]);
    return expectInteger(reply, "lock-renew") === 1;
  }

  /**
   * Run `fn` under the lock. Returns `{ ran: false }` when the lock could not
   * be taken — a refusal, not an exception, because "somebody else is doing it"
   * is a normal outcome the caller branches on rather than an error.
   */
  async withLock<T>(
    key: string,
    fn: () => Promise<T>,
    options: { waitMs?: number } = {},
  ): Promise<{ ran: true; value: T } | { ran: false }> {
    const handle = await this.acquire(key, options);
    if (handle === null) return { ran: false };
    try {
      return { ran: true, value: await fn() };
    } finally {
      await this.release(handle).catch(() => false);
    }
  }

  #key(key: string): string {
    return `${this.#prefix}:${key}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}
