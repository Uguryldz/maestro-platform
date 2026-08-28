import {
  ciResultSignal,
  clarificationAnsweredSignal,
  GATE_OWNER,
  gateDecisionSignal,
  killSwitchSignal,
  modeChangeSignal,
  prChangesRequestedSignal,
  runStateQuery,
} from "@maestro/workflows";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GATE_OWNER_GROUPS,
  isStudioSignal,
  QUERIES,
  SIGNALS,
  STUDIO_SIGNALS,
} from "../src/signal-names.js";

/**
 * The producer/consumer key check. v1 died because a component wrote one key
 * and another read a different one; here the workflow package is imported for
 * real and compared against the constants the HTTP process ships.
 */
describe("signal and query names", () => {
  it("matches the workflow definitions exactly", () => {
    expect(SIGNALS.gateDecision).toBe(gateDecisionSignal.name);
    expect(SIGNALS.clarificationAnswered).toBe(clarificationAnsweredSignal.name);
    expect(SIGNALS.ciResult).toBe(ciResultSignal.name);
    expect(SIGNALS.prChangesRequested).toBe(prChangesRequestedSignal.name);
    expect(SIGNALS.modeChange).toBe(modeChangeSignal.name);
    expect(SIGNALS.killSwitch).toBe(killSwitchSignal.name);
    expect(QUERIES.runState).toBe(runStateQuery.name);
  });

  it("declares every signal the workflow listens for", () => {
    const workflowSignals = [
      gateDecisionSignal,
      clarificationAnsweredSignal,
      ciResultSignal,
      prChangesRequestedSignal,
      modeChangeSignal,
      killSwitchSignal,
    ].map((signal) => signal.name);

    expect(Object.values(SIGNALS).sort()).toEqual(workflowSignals.sort());
  });

  it("keeps CI results and the kill switch off the Studio allow-list", () => {
    expect(isStudioSignal(SIGNALS.ciResult)).toBe(false);
    expect(isStudioSignal(SIGNALS.killSwitch)).toBe(false);
    expect(isStudioSignal(SIGNALS.prChangesRequested)).toBe(false);
    expect(isStudioSignal("anything-else")).toBe(false);
    for (const allowed of STUDIO_SIGNALS) expect(isStudioSignal(allowed)).toBe(true);
  });

  it("mirrors the workflow's gate owner groups", () => {
    expect(DEFAULT_GATE_OWNER_GROUPS).toEqual(GATE_OWNER);
  });
});
