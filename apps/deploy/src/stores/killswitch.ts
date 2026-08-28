import type { KillSwitchLevel, KillSwitchState, KillSwitchStore } from "@maestro/bff";

/**
 * The Postgres-backed `KillSwitchStore` (M58), made durable in Dalga E — the
 * whole point of this file.
 *
 * `InMemoryKillSwitchStore` started at `off` and held the brake in a process
 * field, and the BFF runs under `restart: unless-stopped`. Compose those: an
 * operator sets the switch to `all` during an incident, the container restarts
 * for any reason, and the brake is RELEASED silently with the write paths open
 * again and nothing in the operator's face to say so. "The platform is stopped"
 * was a belief, not a fact, at the moment it had to be a fact. That is why
 * `assertStoresDurable` refused a prod boot without a durable store here; this
 * is that store, and with it wired the kill switch leaves `VOLATILE_STORES`.
 *
 * One row, always. The table's `id` is a fixed sentinel and a CHECK refuses any
 * other value (migration 0008), so `get()` is a point lookup and never "the
 * newest of several" — a state a clock skew between two replicas could
 * otherwise answer wrong at exactly the wrong moment. `set()` UPSERTs that one
 * row, so the current state is always its columns.
 *
 * The delegate is structural, like every other store here: `apps/bff` must not
 * depend on the generated client, and this file compiles before
 * `prisma generate` has run.
 */

/** The single `KillSwitch` row's id. The migration's CHECK refuses any other. */
export const KILL_SWITCH_ROW_ID = "ONLY";

/**
 * The state a database with no row yet reports: the brake is OFF.
 *
 * A fresh install has never touched the switch, and "no row" must read as
 * "off", never as an error that would take the platform down. This mirrors
 * `InMemoryKillSwitchStore`'s initial value so the two stores answer a
 * never-set switch identically. Crucially it is the DEFAULT for a MISSING row,
 * not a fallback that hides a failed read — a query that throws still throws.
 */
export const KILL_SWITCH_OFF: KillSwitchState = {
  level: "off",
  actor: "maestro-worker",
  reason: "initial",
  at: "1970-01-01T00:00:00.000Z",
};

/** The `KillSwitch` row as read/written. */
export interface KillSwitchRow {
  id: string;
  level: string;
  actor: string;
  reason: string;
  at: Date;
}

/**
 * The two `PrismaClient.killSwitch` methods this store uses. `upsert` is what
 * makes `set` idempotent on the single row: the first `set` inserts it, every
 * later one updates it, and there is never a second row to disambiguate.
 */
export interface KillSwitchDelegate {
  findUnique(args: { where: { id: string } }): Promise<KillSwitchRow | null>;
  upsert(args: {
    where: { id: string };
    create: KillSwitchRow;
    update: Omit<KillSwitchRow, "id">;
  }): Promise<unknown>;
}

export class PrismaKillSwitchStore implements KillSwitchStore {
  constructor(private readonly killSwitch: KillSwitchDelegate) {}

  /**
   * The current brake state, or OFF if it was never set.
   *
   * A missing row is "off" (a fresh install); a present row is read back
   * verbatim. The stored `level` is narrowed through `toLevel` rather than cast:
   * the database's CHECK already refuses anything but the three legal values, so
   * this narrowing is a second, in-process guarantee that a level the platform
   * cannot act on can never leave this method as if it could — which for a brake
   * means failing CLOSED (`all`) rather than open, the one direction that is
   * safe when a value is somehow unrecognised.
   */
  async get(): Promise<KillSwitchState> {
    const row = await this.killSwitch.findUnique({ where: { id: KILL_SWITCH_ROW_ID } });
    if (row === null) return { ...KILL_SWITCH_OFF };
    return {
      level: toLevel(row.level),
      actor: row.actor,
      reason: row.reason,
      at: row.at.toISOString(),
    };
  }

  /** Set the brake. UPSERTs the single row, so a restart reads back this state. */
  async set(state: KillSwitchState): Promise<void> {
    const data = {
      level: state.level,
      actor: state.actor,
      reason: state.reason,
      at: new Date(state.at),
    };
    await this.killSwitch.upsert({
      where: { id: KILL_SWITCH_ROW_ID },
      create: { id: KILL_SWITCH_ROW_ID, ...data },
      update: data,
    });
  }
}

/**
 * A stored level string, narrowed to the contract union.
 *
 * The three legal values pass through unchanged. Anything else — which the
 * database's CHECK makes impossible in practice, so this only fires on a schema
 * skew or a hand-edited row — becomes `all`: an unreadable brake must engage,
 * not release. A brake that fails open is worse than no brake, because the
 * operator believes the platform is stopped.
 */
export function toLevel(stored: string): KillSwitchLevel {
  if (stored === "off" || stored === "intake_only" || stored === "all") return stored;
  return "all";
}
