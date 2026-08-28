import type { RunnerLease } from "@maestro/ports";
import type { LinuxPlatform, PlatformSlot } from "./config.js";
import type { IdSource } from "./deps.js";
import { RunnerCapacityError, RunnerLeaseError } from "./errors.js";

/**
 * Slot bookkeeping behind `acquire`/`release` (M21). Kept apart from the
 * Docker driver because capacity is a pure state machine and deserves its own
 * tests: "a busy runner is never handed out" is the invariant that decides
 * whether two jobs can land in the same workspace.
 */

export interface SlotState {
  runnerId: string;
  platform: LinuxPlatform;
  /** Set while a lease holds the slot. */
  leaseId?: string;
  /** True between the start and the end of a `runSession` on this slot. */
  running: boolean;
  /** Dependency caches attached to the lease by `mountCache`. */
  cacheKeys: string[];
}

export interface PoolSnapshot {
  platform: LinuxPlatform;
  capacity: number;
  leased: number;
  running: number;
}

/** How many released lease ids are remembered, to answer "released" vs "unknown". */
const RELEASED_MEMORY = 256;

export class RunnerPool {
  readonly #slots: SlotState[] = [];
  readonly #byLease = new Map<string, SlotState>();
  readonly #released: string[] = [];
  readonly #newId: IdSource;

  constructor(platforms: Partial<Record<LinuxPlatform, PlatformSlot>>, newId: IdSource) {
    for (const [platform, slot] of Object.entries(platforms) as [LinuxPlatform, PlatformSlot][]) {
      for (let index = 0; index < slot.capacity; index += 1) {
        this.#slots.push({ runnerId: `docker-linux/${platform}/${index}`, platform, running: false, cacheKeys: [] });
      }
    }
    this.#newId = newId;
  }

  /** Takes the first free slot of the platform, or fails closed — never queues. */
  acquire(platform: LinuxPlatform): RunnerLease {
    const slot = this.#slots.find((candidate) => candidate.platform === platform && candidate.leaseId === undefined);
    if (slot === undefined) {
      throw new RunnerCapacityError(platform, this.#slots.filter((s) => s.platform === platform).length);
    }
    const leaseId = this.#newId();
    if (this.#byLease.has(leaseId)) throw new RunnerLeaseError(leaseId, "busy");
    slot.leaseId = leaseId;
    slot.cacheKeys = [];
    this.#byLease.set(leaseId, slot);
    return { leaseId, runnerId: slot.runnerId, platform };
  }

  /** The slot a live lease points at. Throws for unknown, released or foreign ids. */
  slotOf(lease: RunnerLease): SlotState {
    const slot = this.#byLease.get(lease.leaseId);
    if (slot === undefined) {
      throw new RunnerLeaseError(lease.leaseId, this.#released.includes(lease.leaseId) ? "released" : "unknown");
    }
    if (slot.runnerId !== lease.runnerId || slot.platform !== lease.platform) {
      // A lease minted by another pool/driver must not steer this one.
      throw new RunnerLeaseError(lease.leaseId, "foreign");
    }
    return slot;
  }

  /** Marks the slot as executing; a second concurrent session is refused. */
  beginSession(lease: RunnerLease): SlotState {
    const slot = this.slotOf(lease);
    if (slot.running) throw new RunnerLeaseError(lease.leaseId, "busy");
    slot.running = true;
    return slot;
  }

  endSession(lease: RunnerLease): void {
    const slot = this.#byLease.get(lease.leaseId);
    if (slot !== undefined) slot.running = false;
  }

  attachCache(lease: RunnerLease, keys: readonly string[]): string[] {
    const slot = this.slotOf(lease);
    for (const key of keys) {
      if (!slot.cacheKeys.includes(key)) slot.cacheKeys.push(key);
    }
    return [...slot.cacheKeys];
  }

  /**
   * Idempotent (the port's contract): the first call frees the slot and
   * returns true, every later call is a no-op returning false. Releasing a
   * lease that never existed is also a no-op — cleanup paths run twice under
   * retry and must not turn a finished job into an error.
   */
  release(lease: RunnerLease): boolean {
    const slot = this.#byLease.get(lease.leaseId);
    if (slot === undefined) return false;
    this.#byLease.delete(lease.leaseId);
    slot.leaseId = undefined;
    slot.running = false;
    slot.cacheKeys = [];
    this.#released.push(lease.leaseId);
    if (this.#released.length > RELEASED_MEMORY) this.#released.shift();
    return true;
  }

  snapshot(): PoolSnapshot[] {
    const platforms = [...new Set(this.#slots.map((slot) => slot.platform))];
    return platforms.map((platform) => {
      const slots = this.#slots.filter((slot) => slot.platform === platform);
      return {
        platform,
        capacity: slots.length,
        leased: slots.filter((slot) => slot.leaseId !== undefined).length,
        running: slots.filter((slot) => slot.running).length,
      };
    });
  }
}
