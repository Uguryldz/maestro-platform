import { LeaseLostError } from "./errors.js";
import type { KillSwitchState } from "./kill-switch.js";
import type { PlatformClient } from "./platform-client.js";
import type { LeasedJob } from "./protocol.js";

/**
 * Lease bookkeeping (task #3).
 *
 * Work is LEASED, not handed over: the platform keeps ownership and the agent
 * holds a time-limited claim it must keep renewing. That is what makes a
 * crashed agent safe — its leases expire and the work is rescheduled — while
 * still making a double-run impossible, because an agent whose renewal is
 * refused must stop before it can finish.
 *
 * The clock is injected. Nothing here sleeps; the caller drives time, so the
 * expiry path is testable without waiting for it.
 */

export interface LeaseRecord {
  job: LeasedJob;
  expiresAt: number;
}

export interface LeaseManagerOptions {
  client: PlatformClient;
  killSwitch: KillSwitchState;
  now: () => Date;
  sessionId: string;
  agentId: string;
  /** Renew this many seconds before expiry. */
  renewMarginSeconds: number;
}

export class LeaseManager {
  readonly #leases = new Map<string, LeaseRecord>();
  readonly #options: LeaseManagerOptions;

  constructor(options: LeaseManagerOptions) {
    this.#options = options;
  }

  /** Lease ids the agent currently believes it holds. */
  held(): string[] {
    return [...this.#leases.keys()];
  }

  get size(): number {
    return this.#leases.size;
  }

  track(job: LeasedJob): void {
    this.#leases.set(job.leaseId, { job, expiresAt: Date.parse(job.leaseExpiresAt) });
  }

  /** Called when a job reaches a terminal state; the lease is no longer ours. */
  forget(leaseId: string): void {
    this.#leases.delete(leaseId);
  }

  /** True when the lease is still held AND has not run past its deadline. */
  isValid(leaseId: string): boolean {
    const record = this.#leases.get(leaseId);
    if (record === undefined) return false;
    return record.expiresAt > this.#options.now().getTime();
  }

  /**
   * Asserts the lease is still the agent's, renewing it when it is close to
   * expiry. Throws `LeaseLostError` when the platform says no — the caller
   * must then stop the job rather than finish it.
   */
  async assertHeld(leaseId: string): Promise<void> {
    const record = this.#leases.get(leaseId);
    if (record === undefined) throw new LeaseLostError(leaseId, "revoked");

    const now = this.#options.now().getTime();
    if (record.expiresAt <= now) {
      // Already past the deadline: the platform is free to have reassigned it,
      // so the agent must not keep working on the assumption that it did not.
      this.#leases.delete(leaseId);
      throw new LeaseLostError(leaseId, "expired");
    }
    const margin = this.#options.renewMarginSeconds * 1_000;
    if (record.expiresAt - now > margin) return;

    await this.renew(leaseId);
  }

  /**
   * Renews one lease. The reply also carries the kill-switch level, which is
   * applied here — this is the second place the switch reaches a RUNNING job
   * (the first is the pull loop), and it is what lets a long build be stopped.
   */
  async renew(leaseId: string): Promise<void> {
    const record = this.#leases.get(leaseId);
    if (record === undefined) throw new LeaseLostError(leaseId, "revoked");

    let reply;
    try {
      reply = await this.#options.client.renewLease({
        sessionId: this.#options.sessionId,
        agentId: this.#options.agentId,
        leaseId,
        at: this.#options.now().toISOString(),
      });
    } catch {
      // A renewal that could not be delivered is NOT a renewal. The lease is
      // left in place so the caller may retry before the deadline, but the
      // deadline itself is untouched — fail-closed, the claim still expires.
      return;
    }

    this.#options.killSwitch.apply(reply.killLevel);

    if (!reply.granted) {
      this.#leases.delete(leaseId);
      throw new LeaseLostError(leaseId, "revoked");
    }
    if (reply.leaseExpiresAt !== undefined) {
      record.expiresAt = Date.parse(reply.leaseExpiresAt);
    }
  }

  /**
   * Drops every lease that ran past its deadline, returning them so the caller
   * can stop the corresponding jobs. This is the crash-safety path made
   * explicit: an agent that was suspended (a closed laptop lid) wakes up
   * holding claims the platform has already given away.
   */
  expire(): LeasedJob[] {
    const now = this.#options.now().getTime();
    const dead: LeasedJob[] = [];
    for (const [leaseId, record] of [...this.#leases]) {
      if (record.expiresAt <= now) {
        this.#leases.delete(leaseId);
        dead.push(record.job);
      }
    }
    return dead;
  }

  /** Releases everything — graceful shutdown hands the work back early. */
  drain(): LeasedJob[] {
    const all = [...this.#leases.values()].map((record) => record.job);
    this.#leases.clear();
    return all;
  }
}
