import { afterEach, describe, expect, it, vi } from "vitest";
import { bootPilot, type PilotStage } from "../src/boot.js";
import { defaultSettings } from "../src/config.js";
import type { VariantModelReader } from "../src/variant.js";

/**
 * DB-first model at BOOT (M38 / Uğur's hard rule) — the last wire.
 *
 * `resolveVariantModel` is unit-tested in `variant.test.ts`; these prove the
 * whole boot honours it, which is the fact that actually matters at runtime:
 *
 *  · when a `variantReader` is wired (the LIVE launcher hands the pilot the
 *    Postgres-backed one), the pilot's displayed/settings model is the VARIANT's
 *    model — what an admin set in Studio — and the env-fallback WARNING is not
 *    logged, because the DB answered.
 *  · with NO reader (the standalone DB-free `main.ts`), the pilot still boots on
 *    the bootstrap `PILOT_MODEL` and the warning IS logged — never silent.
 *
 * Fully offline: a fake reader (no DB), injected fetches, `env: {}` so a polluted
 * developer shell cannot change the boot, ephemeral ports.
 */

const OFFLINE = {
  env: {} as Record<string, string>,
  scm: "fake" as const,
  uiPort: 0,
  adoPort: 0,
  openRouter: { apiKey: "test-key", baseUrl: "http://127.0.0.1:1" },
  jiraCloud: { baseUrl: "https://example.atlassian.net", email: "p@bank.example", apiToken: "t" },
  // A fetch that never touches the network — discovery is off, so it is unused,
  // but keep the pilot hermetic by construction.
  llmFetch: () => Promise.resolve(new Response("{}", { status: 200 })),
  jiraFetch: () => Promise.resolve(new Response("{}", { status: 200 })),
};

let stage: PilotStage | undefined;

afterEach(async () => {
  if (stage !== undefined) {
    await stage.close();
    stage = undefined;
  }
  vi.restoreAllMocks();
});

describe("bootPilot — DB-first model resolution at runtime", () => {
  it("binds the VARIANT's model and does NOT warn when a reader is wired", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reader: VariantModelReader = {
      // Both roles resolve from the DB; the analyst's model is the one displayed.
      activeModel: (variantId) =>
        Promise.resolve(variantId.startsWith("analyst") ? "studio/analyst-model" : "studio/engineer-model"),
    };

    stage = await bootPilot({ ...OFFLINE, variantReader: reader });

    // The displayed model and the seeded settings model are the VARIANT's, not
    // the env `PILOT_MODEL` bootstrap default.
    expect(stage.store.snapshot().model).toBe("studio/analyst-model");
    expect(stage.settings.snapshot().model).toBe("studio/analyst-model");
    // The DB answered, so the "varyant deposu bağlı değil" fallback never fires.
    const fellBack = warn.mock.calls.some((args) =>
      String(args[0]).includes("varyant deposu bağlı değil"),
    );
    expect(fellBack).toBe(false);
  });

  it("falls back to the bootstrap model WITH a warning when no reader is wired (DB-free)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // No variantReader — exactly what standalone main.ts boots.
    stage = await bootPilot({ ...OFFLINE });

    // Falls back to the bootstrap `PILOT_MODEL` — read here as `defaultSettings()`
    // rather than a literal, because `PILOT_MODEL` is a module-load env constant
    // (`env: {}` isolates SCM/Jira/LLM resolution, not this seed). Asserting
    // against the same source proves "the fallback is the env seed" whether the
    // shell is clean (`openai/gpt-4o-mini`) or polluted (`PILOT_MODEL=…`).
    expect(stage.store.snapshot().model).toBe(defaultSettings().model);
    // And it said so, loudly — one warning per role (analyst + engineer).
    const fallbackWarnings = warn.mock.calls.filter((args) =>
      String(args[0]).includes("varyant deposu bağlı değil"),
    );
    expect(fallbackWarnings.length).toBe(2);
  });
});
