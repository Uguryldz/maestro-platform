import { describe, expect, it } from "vitest";
import type { KillSwitchState } from "@maestro/bff";
import {
  KILL_SWITCH_OFF,
  KILL_SWITCH_ROW_ID,
  PrismaKillSwitchStore,
  toLevel,
  type KillSwitchDelegate,
  type KillSwitchRow,
} from "../src/stores/killswitch.js";

/**
 * The Postgres-backed kill switch, offline.
 *
 * The delegate is a single-row fake: `findUnique` reads the one row and
 * `upsert` writes it, exactly as the `KillSwitch` table (one row, sentinel id)
 * behaves. The point of the durable store is that a restart reads back what was
 * set — modelled here by keeping the fake's row across calls.
 */

function fakeDelegate(initial: KillSwitchRow | null = null): {
  delegate: KillSwitchDelegate;
  read(): KillSwitchRow | null;
} {
  let row: KillSwitchRow | null = initial;
  const delegate: KillSwitchDelegate = {
    findUnique: (args) => Promise.resolve(args.where.id === KILL_SWITCH_ROW_ID ? row : null),
    upsert: (args) => {
      row = { id: KILL_SWITCH_ROW_ID, ...args.update };
      return Promise.resolve(row);
    },
  };
  return { delegate, read: () => row };
}

describe("PrismaKillSwitchStore.get", () => {
  it("reads OFF from a database that has never been set (a fresh install)", async () => {
    const { delegate } = fakeDelegate(null);
    const store = new PrismaKillSwitchStore(delegate);
    expect(await store.get()).toEqual(KILL_SWITCH_OFF);
  });

  it("reads back the stored row verbatim", async () => {
    const at = new Date("2026-08-10T10:30:00.000Z");
    const { delegate } = fakeDelegate({
      id: KILL_SWITCH_ROW_ID,
      level: "all",
      actor: "ugur@corp",
      reason: "incident 4711",
      at,
    });
    const store = new PrismaKillSwitchStore(delegate);
    expect(await store.get()).toEqual({
      level: "all",
      actor: "ugur@corp",
      reason: "incident 4711",
      at: "2026-08-10T10:30:00.000Z",
    });
  });

  it("engages (fails CLOSED) when a stored level is somehow unreadable", async () => {
    // The DB CHECK makes this impossible in practice; if a schema skew or a
    // hand-edited row ever produced it, the brake must not read as `off`.
    const { delegate } = fakeDelegate({
      id: KILL_SWITCH_ROW_ID,
      level: "banana",
      actor: "x",
      reason: "y",
      at: new Date("2026-08-10T10:30:00.000Z"),
    });
    const store = new PrismaKillSwitchStore(delegate);
    expect((await store.get()).level).toBe("all");
  });
});

describe("PrismaKillSwitchStore.set", () => {
  it("persists a state that a later get reads back — the durability guarantee", async () => {
    const { delegate } = fakeDelegate(null);
    const store = new PrismaKillSwitchStore(delegate);

    const state: KillSwitchState = {
      level: "intake_only",
      actor: "mert@corp",
      reason: "pausing intake",
      at: "2026-08-10T11:00:00.000Z",
    };
    await store.set(state);

    // A brand-new store over the SAME row (a restart) still reads the state.
    const afterRestart = new PrismaKillSwitchStore(delegate);
    expect(await afterRestart.get()).toEqual(state);
  });

  it("upserts the one sentinel row, never a second (M58)", async () => {
    const { delegate, read } = fakeDelegate(null);
    const store = new PrismaKillSwitchStore(delegate);
    await store.set({ level: "all", actor: "a", reason: "b", at: "2026-08-10T11:00:00.000Z" });
    await store.set({ level: "off", actor: "c", reason: "d", at: "2026-08-10T12:00:00.000Z" });
    expect(read()?.id).toBe(KILL_SWITCH_ROW_ID);
    expect(read()?.level).toBe("off");
  });
});

describe("toLevel", () => {
  it("passes the three legal levels through unchanged", () => {
    expect(toLevel("off")).toBe("off");
    expect(toLevel("intake_only")).toBe("intake_only");
    expect(toLevel("all")).toBe("all");
  });

  it("maps anything unrecognised to `all` — a brake fails closed, never open", () => {
    expect(toLevel("")).toBe("all");
    expect(toLevel("paused")).toBe("all");
  });
});
