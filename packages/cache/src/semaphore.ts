import { randomUUID } from "node:crypto";
import type { RedisClient } from "./client.js";
import { CacheConfigError, PermitNotHeldError } from "./errors.js";
import { expectIntegerArray } from "./resp.js";
import { ScriptRunner } from "./script-runner.js";
import { SEMAPHORE_ACQUIRE_LUA, SEMAPHORE_RELEASE_LUA, SEMAPHORE_RENEW_LUA } from "./scripts.js";

/**
 * Capacity semaphore across processes (M4).
 *
 * What `RunnerPool` in `@maestro/runners` does for one host, this does for a
 * fleet: bound the number of sandboxes, sessions or any other scarce resource
 * that several replicas hand out independently.
 *
 * Every permit is LEASED, never held outright. A holder that crashes cannot run
 * a release, so an un-leased permit would be lost until somebody noticed — and
 * a semaphore that leaks one permit per crash converges on zero capacity, which
 * looks exactly like a hung platform. The lease makes the failure self-healing:
 * the permit returns after `leaseMs` whether or not its owner is alive.
 *
 * The cost of that is a ceiling on how long a permit is valid, so a holder
 * doing long work must `renew`. `hold()` below does it automatically.
 */

export interface SemaphoreOptions {
  readonly capacity: number;
  /**
   * Lease length. Shorter recovers faster from a crash and demands more
   * renewals; it must exceed the renewal interval by a comfortable margin, or
   * a GC pause between heartbeats revokes a live holder's permit.
   */
  readonly leaseMs?: number;
  readonly keyPrefix?: string;
}

export interface Permit {
  readonly token: string;
  readonly key: string;
  readonly expiresAt: Date;
  /** Holders after this acquire — for capacity gauges, not for decisions. */
  readonly holders: number;
}

export type AcquireResult = { readonly granted: true; readonly permit: Permit } | {
  readonly granted: false;
  /** Holders seen at refusal. Equal to capacity unless something expired mid-call. */
  readonly holders: number;
};

const DEFAULT_LEASE_MS = 30_000;

export class RedisSemaphore {
  readonly #acquireScript: ScriptRunner;
  readonly #releaseScript: ScriptRunner;
  readonly #renewScript: ScriptRunner;
  readonly #prefix: string;
  readonly #leaseMs: number;

  constructor(
    private readonly client: RedisClient,
    private readonly options: SemaphoreOptions,
    private readonly now: () => Date = () => new Date(),
    private readonly newToken: () => string = () => randomUUID(),
  ) {
    if (!Number.isInteger(options.capacity) || options.capacity < 1) {
      throw new CacheConfigError("semaphore capacity must be an integer >= 1");
    }
    this.#leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    if (this.#leaseMs < 1_000) {
      // Below a second, ordinary scheduling jitter revokes live holders and the
      // semaphore starts over-subscribing the very thing it bounds.
      throw new CacheConfigError("semaphore leaseMs must be >= 1000 — a shorter lease expires under normal jitter");
    }
    this.#acquireScript = new ScriptRunner(client, SEMAPHORE_ACQUIRE_LUA);
    this.#releaseScript = new ScriptRunner(client, SEMAPHORE_RELEASE_LUA);
    this.#renewScript = new ScriptRunner(client, SEMAPHORE_RENEW_LUA);
    this.#prefix = options.keyPrefix ?? "maestro:sem";
  }

  get leaseMs(): number {
    return this.#leaseMs;
  }

  /** Take a permit, or report that capacity is full. Never queues, never blocks. */
  async acquire(key: string): Promise<AcquireResult> {
    const token = this.newToken();
    const reply = await this.#acquireScript.run(
      [this.#key(key)],
      [this.now().getTime(), this.options.capacity, token, this.#leaseMs],
    );
    const [granted = 0, holders = 0, expiresAt = 0] = expectIntegerArray(reply, "semaphore-acquire");
    if (granted !== 1) return { granted: false, holders };
    return { granted: true, permit: { token, key, expiresAt: new Date(expiresAt), holders } };
  }

  /**
   * Give a permit back.
   *
   * Returns false when the permit had already expired. The caller usually
   * ignores it in a `finally`, but `hold()` surfaces it — work that outran its
   * lease ran unmetered, and that is worth knowing.
   */
  async release(permit: Permit): Promise<boolean> {
    const reply = await this.#releaseScript.run([this.#key(permit.key)], [permit.token]);
    const [released = 0] = expectIntegerArray(reply, "semaphore-release");
    return released === 1;
  }

  /** Extend a live permit. False means it had already expired — do not continue. */
  async renew(permit: Permit): Promise<boolean> {
    const reply = await this.#renewScript.run(
      [this.#key(permit.key)],
      [this.now().getTime(), permit.token, this.#leaseMs],
    );
    const [renewed = 0] = expectIntegerArray(reply, "semaphore-renew");
    return renewed === 1;
  }

  /** Live holders, expired ones excluded. A gauge, not a decision input. */
  async holders(key: string): Promise<number> {
    const reply = await this.client.send(["ZCOUNT", this.#key(key), this.now().getTime(), "+inf"]);
    return typeof reply === "number" ? reply : 0;
  }

  /**
   * Run `fn` holding a permit, renewing in the background, releasing at the end.
   *
   * The heartbeat is at a third of the lease, so two consecutive missed
   * renewals still leave the permit valid — one slow round trip should not
   * revoke a healthy holder.
   *
   * A failed renewal does NOT abort `fn`. Cancelling arbitrary work from a
   * timer is not something this class can do safely, and killing a
   * half-finished sandbox teardown to enforce a counter would trade a capacity
   * overshoot for a resource leak. It records the loss and reports it by
   * throwing after `fn` settles, so the overshoot is visible in a log rather
   * than silent.
   */
  async hold<T>(key: string, fn: (permit: Permit) => Promise<T>): Promise<T> {
    const result = await this.acquire(key);
    if (!result.granted) throw new PermitNotHeldError(key, "(none available)");
    const permit = result.permit;

    let lost = false;
    const timer = setInterval(() => {
      void this.renew(permit).then(
        (ok) => {
          if (!ok) lost = true;
        },
        () => {
          lost = true;
        },
      );
    }, Math.max(500, Math.floor(this.#leaseMs / 3)));
    timer.unref?.();

    try {
      const value = await fn(permit);
      if (lost) throw new PermitNotHeldError(key, permit.token);
      return value;
    } finally {
      clearInterval(timer);
      // Best effort: a Redis outage during teardown must not mask the error
      // `fn` was already throwing, and the lease reclaims the permit anyway.
      await this.release(permit).catch(() => false);
    }
  }

  #key(key: string): string {
    return `${this.#prefix}:${key}`;
  }
}
