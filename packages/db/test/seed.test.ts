import { describe, expect, it } from "vitest";
import { ParamDefinition, ParamKey } from "@maestro/contracts";
import {
  DEFAULT_PARAM_DEFINITIONS,
  GLOBAL_SCOPE_REF,
  SEED_ACTOR,
  seedParams,
} from "../src/index.js";

type SeedDb = Parameters<typeof seedParams>[0];

interface UpsertCall {
  where: Record<string, unknown>;
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}

/** In-memory stand-in for the two delegates the seed touches. No database. */
function fakeDb(): { db: SeedDb; params: UpsertCall[]; versions: UpsertCall[] } {
  const params: UpsertCall[] = [];
  const versions: UpsertCall[] = [];
  const db = {
    param: {
      upsert: (args: UpsertCall) => {
        params.push(args);
        return Promise.resolve(args.create);
      },
    },
    paramVersion: {
      upsert: (args: UpsertCall) => {
        versions.push(args);
        return Promise.resolve(args.create);
      },
    },
  } as unknown as SeedDb;
  return { db, params, versions };
}

/**
 * The parameter set has two sources, and the seed must cover both:
 *
 *  · the mock's "Parametreler" screen (`mock/index.html`, `const PARAMS`) — the
 *    screen a user will open, transliterated to `ParamKey` style because the
 *    contract's regex forbids camelCase;
 *  · knobs an M-decision requires that the mock screen never showed.
 *
 * Asserting a count would be tautological (the count comes from the same array
 * it checks). Asserting *these two lists* is not: adding a parameter without a
 * source, or dropping one the mock shows, fails here.
 */
const MOCK_PARAM_KEYS: Record<string, string> = {
  "gates.risk_tiers": "gates.riskTiers",
  "trigger.mode": "trigger.mode",
  "merge.mode": "merge.mode",
  "escalation.ladder": "escalation.ladder",
  "lang.output": "lang.output",
  "coverage.ratchet": "coverage.ratchet",
  "sod.qa_split": "sod.qaSplit",
  "workspace.max_age_days": "workspace.maxAgeDays",
  "stuck.threshold": "stuck.threshold",
  "quota.warn_pct": "quota.warnPct",
  "build.timeout_min": "build.timeoutMin",
  "scan.block_level": "scan.blockLevel",
};

const DECISION_ONLY_KEYS: Record<string, string> = {
  // Not from a mock screen: the sweep interval came from a live install where
  // no ticket ever arrived because nothing was asking Jira, and the operator
  // needed to tune it from the panel rather than by editing a file on the
  // server and restarting a container.
  "jira.discover_seconds": "keşif",
  "killswitch.state": "M58",
  "binding.dry_run_sample_size": "M102",
  "dataclass.policy": "M18/M63",
  "subscription.queue_enabled": "M55",
  "notify.reminder_channel": "M45",
  "notify.routing": "M45/M87",
  // M45/M87 — the Teams incoming-webhook URL the notifier posts to. Not a mock
  // row; it is a guarded secret param (masked in /params) added with the Teams
  // notification wiring, so it belongs to the decision-only source here.
  "notify.teams.webhook": "M45/M87",
  // M47 — which targets a generated document is published to. The mock screen
  // did not list it; `ParamReader.publishTargets` requires it, and without a
  // stored row the analysis and evidence-summary activities had no answer.
  "publish.targets": "M47",
};

/** The mock's "4-göz" badge, key by key. */
const MOCK_GUARDED_KEYS = [
  "gates.risk_tiers",
  "merge.mode",
  "coverage.ratchet",
  "sod.qa_split",
  "scan.block_level",
];

describe("default parameter definitions", () => {
  const seeded = new Set(DEFAULT_PARAM_DEFINITIONS.map((definition) => definition.key));

  it("ships every parameter the mock's Parametreler screen shows", () => {
    const missing = Object.keys(MOCK_PARAM_KEYS).filter((key) => !seeded.has(key));
    expect(missing).toEqual([]);
  });

  it("ships nothing that has neither a mock row nor an M-decision", () => {
    const orphans = [...seeded].filter(
      (key) => MOCK_PARAM_KEYS[key] === undefined && DECISION_ONLY_KEYS[key] === undefined,
    );
    expect(orphans).toEqual([]);
  });

  it("covers exactly the union of both sources", () => {
    const expected = new Set([...Object.keys(MOCK_PARAM_KEYS), ...Object.keys(DECISION_ONLY_KEYS)]);
    expect([...seeded].sort()).toEqual([...expected].sort());
  });

  it("validates against the ParamDefinition contract", () => {
    for (const def of DEFAULT_PARAM_DEFINITIONS) {
      const parsed = ParamDefinition.safeParse(def);
      expect(parsed.success, `${def.key}: ${parsed.error?.message ?? ""}`).toBe(true);
    }
  });

  it("uses unique, contract-shaped keys", () => {
    const keys = DEFAULT_PARAM_DEFINITIONS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(ParamKey.safeParse(key).success, key).toBe(true);
  });

  it("names every description through the i18n catalog (M104)", () => {
    for (const def of DEFAULT_PARAM_DEFINITIONS) {
      expect(def.descriptionKey.startsWith("params.description."), def.key).toBe(true);
    }
  });

  it("declares enumValues exactly for enum-typed parameters", () => {
    for (const def of DEFAULT_PARAM_DEFINITIONS) {
      if (def.type === "enum") {
        expect(def.enumValues, def.key).toBeDefined();
        expect((def.enumValues ?? []).length, def.key).toBeGreaterThan(1);
      } else {
        expect(def.enumValues, def.key).toBeUndefined();
      }
    }
  });

  it("gives every parameter a default matching its declared type", () => {
    for (const def of DEFAULT_PARAM_DEFINITIONS) {
      switch (def.type) {
        case "boolean":
          expect(typeof def.defaultValue, def.key).toBe("boolean");
          break;
        case "number":
          expect(typeof def.defaultValue, def.key).toBe("number");
          break;
        case "string":
          expect(typeof def.defaultValue, def.key).toBe("string");
          break;
        case "enum":
          expect(def.enumValues ?? [], def.key).toContain(def.defaultValue);
          break;
        case "json":
          expect(typeof def.defaultValue, def.key).toBe("object");
          break;
      }
    }
  });

  it("four-eyes guards every parameter the mock badges, and the policy knobs", () => {
    const guarded = DEFAULT_PARAM_DEFINITIONS.filter((d) => d.guarded).map((d) => d.key).sort();
    for (const key of MOCK_GUARDED_KEYS) expect(guarded, key).toContain(key);
    expect(guarded).toEqual(
      [...MOCK_GUARDED_KEYS, "killswitch.state", "dataclass.policy"].sort(),
    );
  });
});

describe("seedParams", () => {
  const now = new Date("2026-08-08T09:00:00.000Z");
  const total = DEFAULT_PARAM_DEFINITIONS.length;

  it("upserts one definition and one initial version per parameter", async () => {
    const { db, params, versions } = fakeDb();
    const result = await seedParams(db, { now });

    expect(result).toEqual({ definitions: total, initialVersions: total });
    expect(params.length).toBe(total);
    expect(versions.length).toBe(total);
  });

  it("writes the definition remainder into defJson", async () => {
    const { db, params } = fakeDb();
    await seedParams(db, { now });

    const gateSet = params.find((p) => p.where["key"] === "gates.risk_tiers");
    expect(gateSet?.create).toMatchObject({
      key: "gates.risk_tiers",
      scope: "global",
      type: "json",
      guarded: true,
    });
    expect(gateSet?.create["defJson"]).toEqual({
      enumValues: null,
      descriptionKey: "params.description.gate_set",
      defaultValue: {
        dusuk: ["5", "12"],
        orta: ["4", "5", "11", "12"],
        kritik: ["4", "5", "9", "11", "12"],
      },
    });
  });

  it("records version 1 at the global scope ref with the injected clock", async () => {
    const { db, versions } = fakeDb();
    await seedParams(db, { now });

    for (const version of versions) {
      expect(version.create).toMatchObject({
        scopeRef: GLOBAL_SCOPE_REF,
        version: 1,
        changedBy: SEED_ACTOR,
        at: now,
      });
    }
  });

  it("satisfies the four-eyes CHECK on every guarded default (M71)", async () => {
    const { db, versions } = fakeDb();
    await seedParams(db, { now });

    const guardedKeys = new Set(
      DEFAULT_PARAM_DEFINITIONS.filter((d) => d.guarded).map((d) => d.key),
    );
    for (const version of versions) {
      const key = String(version.create["key"]);
      expect(version.create["guarded"], key).toBe(guardedKeys.has(key));
      expect(version.create["approvedBy"], key).toBe(guardedKeys.has(key) ? SEED_ACTOR : null);
    }
  });

  it("never overwrites an operator's value on re-run", async () => {
    const { db, params, versions } = fakeDb();
    await seedParams(db, { now });

    // Definitions are code-owned, so they are refreshed...
    expect(params.every((p) => Object.keys(p.update).length > 0)).toBe(true);
    // ...but values are only ever created.
    expect(versions.every((v) => Object.keys(v.update).length === 0)).toBe(true);
  });

  it("accepts an explicit actor", async () => {
    const { db, versions } = fakeDb();
    await seedParams(db, { now, changedBy: "ugur@corp" });
    expect(versions[0]?.create["changedBy"]).toBe("ugur@corp");
  });
});
