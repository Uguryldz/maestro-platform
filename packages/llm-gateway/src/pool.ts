import type { QuotaWindowKind, SubscriptionAccount, SubscriptionDriverId } from "@maestro/contracts";
import { SubscriptionAccount as SubscriptionAccountSchema } from "@maestro/contracts";
import type { SubscriptionAccountConfig, SubscriptionPoolConfig } from "./config.js";
import { LlmConfigError } from "./errors.js";

/** Window lengths (M55): the 5-hour rolling window and the weekly cap. */
export const WINDOW_MS: Record<QuotaWindowKind, number> = {
  "5h": 5 * 60 * 60 * 1_000,
  weekly: 7 * 24 * 60 * 60 * 1_000,
};

interface Window {
  kind: QuotaWindowKind;
  usedPct: number;
  costPctPerCall: number;
  /** Epoch ms; rolled forward whenever the clock passes it. */
  resetsAtMs: number;
}

interface Seat {
  cfg: SubscriptionAccountConfig;
  windows: Window[];
  lastUsedAtMs: number | null;
  /** Calls handed out by `acquire` that have not reported back yet. */
  reserved: number;
}

export interface PoolAcquisition {
  accountId: string;
  transport: SubscriptionAccountConfig["transport"];
  credentialRef: string;
}

export type PoolResult =
  | { ok: true; account: PoolAcquisition }
  /** Whole pool is full — the caller QUEUES (Temporal waits), never fails. */
  | { ok: false; resumeAt: string };

/**
 * Quota-aware account pool (M55). Cost is a quota window, not dollars: the pool
 * tracks per-account 5h/weekly usage, skips full or cooling seats, picks the one
 * with the most headroom, and — when every seat is full — reports the earliest
 * window reset so the workflow can sleep until then instead of erroring out.
 */
export class SubscriptionPool {
  private readonly seats: Seat[];

  constructor(
    private readonly cfg: SubscriptionPoolConfig,
    private readonly now: () => Date,
  ) {
    const seen = new Set<string>();
    for (const account of cfg.accounts) {
      if (seen.has(account.accountId)) {
        throw new LlmConfigError(`duplicate subscription account "${account.accountId}"`);
      }
      seen.add(account.accountId);
    }
    const startedAt = now().getTime();
    this.seats = cfg.accounts.map((account) => ({
      cfg: account,
      lastUsedAtMs: null,
      reserved: 0,
      windows: account.windows.map((w) => ({ ...w, usedPct: 0, resetsAtMs: startedAt + WINDOW_MS[w.kind] })),
    }));
  }

  /**
   * Reserve the seat with the most headroom, or report when to resume. The
   * reservation is applied at selection time and not when the call reports
   * back: twenty parallel callers would otherwise all read an empty seat and
   * pile onto it, which is how a "40% full" pool runs out of real quota.
   */
  acquire(driver: SubscriptionDriverId): PoolResult {
    const nowMs = this.now().getTime();
    const seats = this.seatsOf(driver, nowMs);
    if (seats.length === 0) {
      throw new LlmConfigError(`subscription pool has no enabled account for driver "${driver}"`);
    }

    const ready = seats.filter((s) => this.stateOf(s, nowMs) === "ready");
    const chosen = ready.sort((a, b) => this.compare(a, b))[0];
    if (!chosen) return { ok: false, resumeAt: new Date(this.earliestFreeAt(seats, nowMs)).toISOString() };

    this.burn(chosen, 1, nowMs);
    chosen.reserved += 1;

    const { accountId, transport, credentialRef } = chosen.cfg;
    return { ok: true, account: { accountId, transport, credentialRef } };
  }

  /**
   * Reconcile a reservation with what the call really cost. `calls` is the
   * number of PHYSICAL provider calls the logical call caused — a schema repair
   * round and every HTTP retry included — of which `acquire` already burned
   * one. Called in a `finally`: a failed call consumed the window too, so its
   * reservation is never handed back.
   */
  record(accountId: string, calls = 1): void {
    const nowMs = this.now().getTime();
    const seat = this.seats.find((s) => s.cfg.accountId === accountId);
    if (!seat) throw new LlmConfigError(`unknown subscription account "${accountId}"`);
    this.rollWindows(seat, nowMs);
    const alreadyBurned = seat.reserved > 0 ? 1 : 0;
    if (seat.reserved > 0) seat.reserved -= 1;
    this.burn(seat, Math.max(0, calls - alreadyBurned), nowMs);
  }

  private burn(seat: Seat, calls: number, nowMs: number): void {
    seat.lastUsedAtMs = nowMs;
    if (calls <= 0) return;
    for (const w of seat.windows) w.usedPct = Math.min(100, w.usedPct + w.costPctPerCall * calls);
  }

  /** Contract-validated view for Studio/KPI surfaces (M62). */
  snapshot(): SubscriptionAccount[] {
    const nowMs = this.now().getTime();
    return this.seats.map((seat) => {
      this.rollWindows(seat, nowMs);
      return SubscriptionAccountSchema.parse({
        accountId: seat.cfg.accountId,
        driver: seat.cfg.driver,
        state: this.stateOf(seat, nowMs),
        lastUsedAt: seat.lastUsedAtMs === null ? null : new Date(seat.lastUsedAtMs).toISOString(),
        windows: seat.windows.map((w) => ({ kind: w.kind, usedPct: round2(w.usedPct), resetsAt: new Date(w.resetsAtMs).toISOString() })),
      });
    });
  }

  private seatsOf(driver: SubscriptionDriverId, nowMs: number): Seat[] {
    const seats = this.seats.filter((s) => s.cfg.driver === driver && s.cfg.enabled);
    for (const seat of seats) this.rollWindows(seat, nowMs);
    return seats;
  }

  private rollWindows(seat: Seat, nowMs: number): void {
    for (const w of seat.windows) {
      if (w.resetsAtMs > nowMs) continue;
      const length = WINDOW_MS[w.kind];
      const elapsed = nowMs - w.resetsAtMs;
      w.resetsAtMs += length * (Math.floor(elapsed / length) + 1);
      w.usedPct = 0;
    }
  }

  private stateOf(seat: Seat, nowMs: number): SubscriptionAccount["state"] {
    if (!seat.cfg.enabled) return "disabled";
    if (seat.windows.some((w) => w.usedPct >= this.cfg.exhaustedAtPct)) return "exhausted";
    if (seat.lastUsedAtMs !== null && seat.lastUsedAtMs + this.cfg.cooldownMs > nowMs) return "cooling";
    return "ready";
  }

  /** Headroom = the tightest window's remaining percentage. */
  private headroom(seat: Seat): number {
    return Math.min(...seat.windows.map((w) => this.cfg.exhaustedAtPct - w.usedPct));
  }

  /** Most headroom first; ties break to the least recently used, then by id. */
  private compare(a: Seat, b: Seat): number {
    const byHeadroom = this.headroom(b) - this.headroom(a);
    if (byHeadroom !== 0) return byHeadroom;
    const byLastUsed = (a.lastUsedAtMs ?? -1) - (b.lastUsedAtMs ?? -1);
    if (byLastUsed !== 0) return byLastUsed;
    return a.cfg.accountId.localeCompare(b.cfg.accountId);
  }

  /**
   * Earliest moment any seat becomes usable again. Per seat this is the LAST
   * of its blockers — a seat whose 5h window frees at noon but whose weekly cap
   * holds until Friday is not usable at noon.
   */
  private earliestFreeAt(seats: Seat[], nowMs: number): number {
    const times = seats.map((seat) => {
      const cooling = seat.lastUsedAtMs === null ? nowMs : seat.lastUsedAtMs + this.cfg.cooldownMs;
      const full = seat.windows.filter((w) => w.usedPct >= this.cfg.exhaustedAtPct);
      return Math.max(cooling, ...full.map((w) => w.resetsAtMs));
    });
    return Math.min(...times);
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
