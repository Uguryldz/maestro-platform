import { describe, expect, it } from "vitest";
import {
  POLL_MS_MAX,
  POLL_MS_MIN,
  SettingsStore,
  SettingsValidationError,
  validateSettings,
  type PilotSettings,
} from "../src/settings.js";

/**
 * SettingsStore validation and seeding, entirely offline. Every bound is checked:
 * a poll that is zero/negative/huge/non-integer is rejected; a bad data class,
 * an empty model or group is rejected; a valid patch is accepted and normalised.
 * The store seeds from a provided (env-shaped) map and never invents values.
 */

const SEED: Record<keyof PilotSettings, unknown> = {
  approverGroup: "jira-users-uyildiz",
  model: "openai/gpt-4o-mini",
  commandPollMs: 3_000,
  discoveryPollMs: 15_000,
  dataClass: "gizli",
  operatorAccount: "op@corp",
  sandboxRoot: "",
  reviewStatusName: "İNCELEMEDE",
  autoMerge: false,
  autoStart: true,
};

describe("validateSettings — poll bounds", () => {
  it("rejects a zero poll interval", () => {
    expect(() => validateSettings(SEED as PilotSettings, { commandPollMs: 0 })).toThrow(
      SettingsValidationError,
    );
  });

  it("rejects a negative poll interval", () => {
    expect(() => validateSettings(SEED as PilotSettings, { discoveryPollMs: -1 })).toThrow(
      SettingsValidationError,
    );
  });

  it("rejects a poll interval below the minimum", () => {
    expect(() => validateSettings(SEED as PilotSettings, { commandPollMs: POLL_MS_MIN - 1 })).toThrow(
      /aralığında/,
    );
  });

  it("rejects a poll interval above the maximum", () => {
    expect(() => validateSettings(SEED as PilotSettings, { discoveryPollMs: POLL_MS_MAX + 1 })).toThrow(
      /aralığında/,
    );
  });

  it("rejects a non-integer poll interval", () => {
    expect(() => validateSettings(SEED as PilotSettings, { commandPollMs: 1500.5 })).toThrow(
      /tam sayı/,
    );
  });

  it("accepts poll intervals at the exact bounds", () => {
    const next = validateSettings(SEED as PilotSettings, {
      commandPollMs: POLL_MS_MIN,
      discoveryPollMs: POLL_MS_MAX,
    });
    expect(next.commandPollMs).toBe(POLL_MS_MIN);
    expect(next.discoveryPollMs).toBe(POLL_MS_MAX);
  });
});

describe("validateSettings — data class", () => {
  it("rejects an unknown data class", () => {
    expect(() => validateSettings(SEED as PilotSettings, { dataClass: "top-secret" })).toThrow(
      /veri sınıfı/,
    );
  });

  it.each(["acik", "dahili", "gizli"])("accepts %s", (value) => {
    expect(validateSettings(SEED as PilotSettings, { dataClass: value }).dataClass).toBe(value);
  });
});

describe("validateSettings — non-empty strings", () => {
  it("rejects an empty model", () => {
    expect(() => validateSettings(SEED as PilotSettings, { model: "  " })).toThrow(/model boş/);
  });

  it("rejects an empty approver group", () => {
    expect(() => validateSettings(SEED as PilotSettings, { approverGroup: "" })).toThrow(/boş/);
  });

  it("rejects an empty operator account", () => {
    expect(() => validateSettings(SEED as PilotSettings, { operatorAccount: "" })).toThrow(/boş/);
  });

  it("rejects control characters (CRLF) at the panel, not at gate time", () => {
    // operatorAccount reaches the audit actor; approverGroup reaches a query.
    // A newline is neutralized downstream, but must fail HERE, loudly.
    expect(() =>
      validateSettings(SEED as PilotSettings, { operatorAccount: "evil@corp\nGATE forged" }),
    ).toThrow(/kontrol karakteri/);
    expect(() =>
      validateSettings(SEED as PilotSettings, { approverGroup: "grp\r\nX-Injected: 1" }),
    ).toThrow(/kontrol karakteri/);
  });

  it("trims accepted strings", () => {
    const next = validateSettings(SEED as PilotSettings, { model: "  gpt-5  " });
    expect(next.model).toBe("gpt-5");
  });
});

describe("validateSettings — sandboxRoot (persistent KÖK)", () => {
  it("accepts an empty root (persistent root OFF → mkdtemp fallback)", () => {
    const next = validateSettings(SEED as PilotSettings, { sandboxRoot: "" });
    expect(next.sandboxRoot).toBe("");
    // Whitespace-only is normalised to empty too.
    expect(validateSettings(SEED as PilotSettings, { sandboxRoot: "   " }).sandboxRoot).toBe("");
  });

  it("accepts and trims an absolute path", () => {
    const next = validateSettings(SEED as PilotSettings, { sandboxRoot: "  /srv/maestro/sandbox  " });
    expect(next.sandboxRoot).toBe("/srv/maestro/sandbox");
  });

  it("rejects a relative path (the root must be a single stable location)", () => {
    expect(() =>
      validateSettings(SEED as PilotSettings, { sandboxRoot: "relative/sandbox" }),
    ).toThrow(/mutlak/);
    expect(() =>
      validateSettings(SEED as PilotSettings, { sandboxRoot: "./sandbox" }),
    ).toThrow(/mutlak/);
  });

  it("rejects control characters in the root", () => {
    expect(() =>
      validateSettings(SEED as PilotSettings, { sandboxRoot: "/srv/sand\nbox" }),
    ).toThrow(/kontrol karakteri/);
  });
});

describe("validateSettings — partial patch", () => {
  it("keeps unmentioned fields unchanged", () => {
    const next = validateSettings(SEED as PilotSettings, { model: "gpt-5" });
    expect(next.model).toBe("gpt-5");
    expect(next.approverGroup).toBe(SEED.approverGroup);
    expect(next.commandPollMs).toBe(SEED.commandPollMs);
  });
});

describe("SettingsStore", () => {
  it("seeds from the provided env-shaped map", () => {
    const store = new SettingsStore(SEED);
    expect(store.snapshot()).toEqual({
      approverGroup: "jira-users-uyildiz",
      model: "openai/gpt-4o-mini",
      commandPollMs: 3_000,
      discoveryPollMs: 15_000,
      dataClass: "gizli",
      operatorAccount: "op@corp",
      sandboxRoot: "",
      reviewStatusName: "İNCELEMEDE",
      autoMerge: false,
      autoStart: true,
    });
  });

  it("throws when seeded with an invalid value (boot fails loudly)", () => {
    expect(() => new SettingsStore({ ...SEED, commandPollMs: 0 })).toThrow(SettingsValidationError);
  });

  it("snapshot returns a copy — mutating it does not change the store", () => {
    const store = new SettingsStore(SEED);
    const snap = store.snapshot();
    snap.model = "tampered";
    expect(store.snapshot().model).toBe("openai/gpt-4o-mini");
  });

  it("update applies a valid patch and returns the new values", () => {
    const store = new SettingsStore(SEED);
    const updated = store.update({ commandPollMs: 5_000, dataClass: "dahili" });
    expect(updated.commandPollMs).toBe(5_000);
    expect(updated.dataClass).toBe("dahili");
    expect(store.snapshot().commandPollMs).toBe(5_000);
  });

  it("update rejects an invalid patch WITHOUT mutating the store", () => {
    const store = new SettingsStore(SEED);
    expect(() => store.update({ commandPollMs: -5 })).toThrow(SettingsValidationError);
    expect(store.snapshot().commandPollMs).toBe(3_000); // unchanged
  });

  it("exposes no secret fields — only the settable settings", () => {
    const store = new SettingsStore(SEED);
    expect(Object.keys(store.snapshot()).sort()).toEqual(
      ["approverGroup", "commandPollMs", "dataClass", "discoveryPollMs", "model", "operatorAccount", "sandboxRoot", "reviewStatusName", "autoMerge", "autoStart"].sort(),
    );
  });
});
