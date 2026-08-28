import { describe, expect, it } from "vitest";
import { ExecutionConfigError } from "../src/errors.js";
import {
  DEFAULT_STRIKE_LIMIT,
  handoverDecision,
  MSG_HANDOVER_STUCK,
  StrikeLedger,
  type StrikeKey,
} from "../src/strikes.js";
import { tickingClock } from "./helpers.js";

const gate5: StrikeKey = { runId: "run-1", scope: "gate", ref: "5" };

describe("StrikeLedger", () => {
  it("hands over on the third rejection at the same gate, not before (M54)", () => {
    const ledger = new StrikeLedger(tickingClock());
    expect(ledger.record(gate5, "TL asked for changes").handover).toBe(false);
    expect(ledger.record(gate5, "TL asked again").handover).toBe(false);
    const third = ledger.record(gate5, "TL still unhappy");
    expect(third.count).toBe(3);
    expect(third.handover).toBe(true);
    expect(third.reasons).toEqual(["TL asked for changes", "TL asked again", "TL still unhappy"]);
  });

  it("keeps different gates, scopes and runs on separate counters", () => {
    const ledger = new StrikeLedger(tickingClock());
    ledger.record(gate5, "a");
    ledger.record(gate5, "b");
    expect(ledger.record({ ...gate5, ref: "4" }, "c").count).toBe(1);
    expect(ledger.record({ ...gate5, scope: "ci" }, "d").count).toBe(1);
    expect(ledger.record({ ...gate5, runId: "run-2" }, "e").count).toBe(1);
    expect(ledger.state(gate5)?.count).toBe(2);
  });

  it("clears only the key that succeeded", () => {
    const ledger = new StrikeLedger(tickingClock());
    ledger.record(gate5, "a");
    ledger.record({ ...gate5, scope: "ci", ref: "x" }, "b");
    ledger.clear(gate5);
    expect(ledger.state(gate5)).toBeNull();
    expect(ledger.state({ ...gate5, scope: "ci", ref: "x" })?.count).toBe(1);
  });

  it("takes N from configuration (M54: N is parametric)", () => {
    const ledger = new StrikeLedger(tickingClock(), 2);
    expect(ledger.record(gate5, "a").handover).toBe(false);
    expect(ledger.record(gate5, "b").handover).toBe(true);
    expect(DEFAULT_STRIKE_LIMIT).toBe(3);
  });

  it("rejects a limit that would disable the protection", () => {
    expect(() => new StrikeLedger(tickingClock(), 0)).toThrow(ExecutionConfigError);
    expect(() => new StrikeLedger(tickingClock(), 1.5)).toThrow(ExecutionConfigError);
  });

  it("timestamps first and last failure from the injected clock", () => {
    const ledger = new StrikeLedger(tickingClock("2026-08-08T10:00:00.000Z"));
    ledger.record(gate5, "a");
    const second = ledger.record(gate5, "b");
    expect(second.firstAt).toBe("2026-08-08T10:00:00.000Z");
    expect(second.lastAt).toBe("2026-08-08T10:00:01.000Z");
  });

  it("lists every stuck key of a run as the handover's evidence", () => {
    const ledger = new StrikeLedger(tickingClock(), 1);
    ledger.record(gate5, "a");
    ledger.record({ runId: "run-1", scope: "ci", ref: "abc" }, "b");
    ledger.record({ runId: "run-2", scope: "ci", ref: "abc" }, "c");
    expect(ledger.stuckKeys("run-1").map((s) => s.key.scope).sort()).toEqual(["ci", "gate"]);
  });
});

describe("handoverDecision", () => {
  it("drops to ai-assist with an i18n key rather than a message (M54/M97/M104)", () => {
    const ledger = new StrikeLedger(tickingClock(), 1);
    const decision = handoverDecision(ledger.record(gate5, "TL rejected"));
    expect(decision).toMatchObject({
      handover: true,
      workMode: "ai_assist",
      messageKey: MSG_HANDOVER_STUCK,
      count: 1,
      limit: 1,
      reasons: ["TL rejected"],
    });
    expect(decision.key).toEqual(gate5);
  });

  it("reports no handover while the count is below the limit", () => {
    const ledger = new StrikeLedger(tickingClock());
    expect(handoverDecision(ledger.record(gate5, "first")).handover).toBe(false);
  });
});
