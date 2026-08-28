import { describe, expect, it } from "vitest";
import { EscalationLadder, NotifyRouting, resolveSteps } from "@maestro/notify";
import { DEFAULT_PARAM_DEFINITIONS } from "../src/index.js";
import { DEMO_PARAM_VERSIONS } from "../src/demo/params.js";

/**
 * M71: settings live in the database. So the notify package ships NO default
 * ladder and NO default routing — the seeded parameter IS the default, and it
 * is only a real default if it parses against the schema that consumes it.
 *
 * Parsing here is what makes the two halves one decision: a seed the escalation
 * engine would reject at runtime fails this test instead of a gate.
 */
function seeded(key: string): unknown {
  const definition = DEFAULT_PARAM_DEFINITIONS.find((entry) => entry.key === key);
  expect(definition, `missing seed parameter ${key}`).toBeDefined();
  return definition!.defaultValue;
}

describe("escalation.ladder is the single source of the M88 ladder", () => {
  it("parses with the schema the escalation engine uses", () => {
    expect(() => EscalationLadder.parse(seeded("escalation.ladder"))).not.toThrow();
  });

  it("is the 24h → 72h → 7d ladder, with a real delegation at the end", () => {
    const ladder = EscalationLadder.parse(seeded("escalation.ladder"));
    expect(ladder.steps.map((step) => step.afterHours)).toEqual([24, 72, 168]);

    const last = ladder.steps.at(-1)!;
    expect(last.action).toBe("delegate");
    // The deputy must be told they were handed the gate, not re-escalated at.
    expect(last.messageKey).toBe("notify.delegated");
  });

  it("seeds a persistent id on every step (they are what `firedStepIds` stores)", () => {
    const ladder = EscalationLadder.parse(seeded("escalation.ladder"));
    const ids = ladder.steps.map((step) => step.id);
    expect(ids.every((id) => id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(() => resolveSteps(ladder)).not.toThrow();
  });

  it("keeps every stored ladder VERSION parseable, ids included", () => {
    const ladders = DEMO_PARAM_VERSIONS.filter((version) => version.key === "escalation.ladder");
    expect(ladders.length).toBeGreaterThan(0);
    for (const version of ladders) {
      const parsed = EscalationLadder.parse(version.valueJson);
      expect(() => resolveSteps(parsed), `version ${version.version}`).not.toThrow();
    }
  });

  it("keeps the demo history's own delegation step honest", () => {
    const latest = DEMO_PARAM_VERSIONS.filter((version) => version.key === "escalation.ladder").at(-1)!;
    const ladder = EscalationLadder.parse(latest.valueJson);
    expect(ladder.steps.filter((step) => step.action === "delegate")).toHaveLength(1);
  });
});

describe("notify.routing binds M87 to a real parameter", () => {
  it("parses with the schema the routing function uses", () => {
    expect(() => NotifyRouting.parse(seeded("notify.routing"))).not.toThrow();
  });

  it("routes the ops-facing events M87 names", () => {
    const routing = NotifyRouting.parse(seeded("notify.routing"));
    expect(routing.default.length).toBeGreaterThan(0);
    expect(routing.byEvent.runner_health?.length).toBeGreaterThan(0);
    expect(routing.byEvent.kill_switch?.length).toBeGreaterThan(0);
  });
});
