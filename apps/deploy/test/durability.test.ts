import { InMemoryKillSwitchStore } from "@maestro/bff";
import { describe, expect, it } from "vitest";
import {
  assertStoresDurable,
  DurabilityError,
  FATAL_IF_VOLATILE,
  volatileStoreWarning,
  type StoreDurability,
} from "../src/stores/durability.js";

/**
 * K-1: the emergency brake must not release itself.
 *
 * `InMemoryKillSwitchStore` starts at `off` and the `bff` service runs under
 * `restart: unless-stopped`, so a process-local switch means an operator who
 * stops the platform during an incident gets it started again by the next
 * restart — silently. These tests pin both halves of the fix: the store really
 * does forget, and the prod profile really does refuse to boot on top of one.
 */

const KILL_SWITCH: StoreDurability = {
  name: "killSwitch",
  durable: false,
  onRestart: "the emergency brake reverts to `off` with nobody told (M58)",
};

const SESSIONS: StoreDurability = {
  name: "sessions",
  durable: false,
  onRestart: "every logged-in user is signed out",
};

describe("the volatility this guard exists for is real", () => {
  /**
   * Not a tautology check — this is the behaviour that makes the refusal
   * necessary, demonstrated rather than asserted about.
   */
  it("loses an engaged kill switch when the process restarts", async () => {
    const before = new InMemoryKillSwitchStore();
    await before.set({
      level: "all",
      actor: "yonetici@ugurbank.local",
      reason: "olay",
      at: "2026-08-09T09:00:00.000Z",
    });
    expect((await before.get()).level).toBe("all");

    // A restart is a new process, which is a new store.
    const after = new InMemoryKillSwitchStore();

    expect((await after.get()).level).toBe("off");
    expect((await after.get()).reason).toBe("initial");
  });
});

describe("assertStoresDurable", () => {
  it("refuses a prod boot whose kill switch is process-local", () => {
    expect(() => assertStoresDurable("prod", [KILL_SWITCH])).toThrow(DurabilityError);
  });

  /** The refusal has to be actionable: it names the store and the remedy. */
  it("names the store and what the deployment must supply", () => {
    const error = catchError(() => assertStoresDurable("prod", [KILL_SWITCH]));

    expect(error).toBeInstanceOf(DurabilityError);
    expect(error?.message).toContain("killSwitch");
    expect(error?.message).toContain("KillSwitchStore");
    expect(error?.message).toContain("restart: unless-stopped");
  });

  /** The dev stack has no Postgres kill-switch store; it is allowed to say so. */
  it("permits the dev profile", () => {
    expect(() => assertStoresDurable("dev", [KILL_SWITCH])).not.toThrow();
  });

  it("accepts prod once the kill switch is durable", () => {
    expect(() =>
      assertStoresDurable("prod", [{ ...KILL_SWITCH, durable: true }]),
    ).not.toThrow();
  });

  /**
   * Only the kill switch is fatal, and that narrowness is deliberate: a lost
   * session costs a re-login. A guard that refused on every volatile store
   * would have to be switched off to boot at all, which is how guards die.
   */
  it("does not refuse on a volatile store that is merely inconvenient", () => {
    expect(() => assertStoresDurable("prod", [SESSIONS])).not.toThrow();
  });

  it("still refuses when the fatal store is listed among harmless ones", () => {
    expect(() => assertStoresDurable("prod", [SESSIONS, KILL_SWITCH])).toThrow(DurabilityError);
  });

  it("treats the kill switch as the fatal store", () => {
    expect(FATAL_IF_VOLATILE).toContain("killSwitch");
  });
});

describe("volatileStoreWarning", () => {
  /** Dev may run this way, but the operator must not have to infer it. */
  it("names every process-local store and what a restart costs", () => {
    const warning = volatileStoreWarning([KILL_SWITCH, SESSIONS]);

    expect(warning).toContain("killSwitch");
    expect(warning).toContain("sessions");
    expect(warning).toContain("releases the brake");
  });

  it("says nothing when every store is durable", () => {
    expect(volatileStoreWarning([{ ...KILL_SWITCH, durable: true }])).toBeNull();
  });
});

function catchError(run: () => void): Error | null {
  try {
    run();
    return null;
  } catch (error) {
    return error as Error;
  }
}
