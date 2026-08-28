import { AuditAction } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import { AUDIT_ACTION_INFO, actionInfo } from "../src/index.js";

describe("AuditAction → SIEM metadata table", () => {
  it("covers every contract action and nothing else", () => {
    // The Record type makes a missing action a compile error; this guards the
    // other direction — a stale entry for an action that no longer exists.
    expect(Object.keys(AUDIT_ACTION_INFO).sort()).toEqual([...AuditAction.options].sort());
  });

  it("gives every action a CEF severity in range and a human-readable name", () => {
    for (const action of AuditAction.options) {
      const info = actionInfo(action);
      expect(Number.isInteger(info.severity), action).toBe(true);
      expect(info.severity, action).toBeGreaterThanOrEqual(0);
      expect(info.severity, action).toBeLessThanOrEqual(10);
      expect(info.name.length, action).toBeGreaterThan(3);
      expect(info.name, action).not.toBe(action);
    }
  });

  it("ranks the actions an operator must never miss above the routine ones", () => {
    expect(actionInfo("KILL_SWITCH").severity).toBe(10);
    expect(actionInfo("SECURITY_SCAN_FAIL").severity).toBeGreaterThan(actionInfo("SECURITY_SCAN_PASS").severity);
    expect(actionInfo("PARAM_CHANGED").severity).toBeGreaterThan(actionInfo("RUN_STARTED").severity);
    expect(actionInfo("BINDING_CHANGED").severity).toBeGreaterThan(actionInfo("RUN_STARTED").severity);
  });

  it("marks exactly the gate decisions as human-only (M32/M101)", () => {
    const humanOnly = AuditAction.options.filter((action) => AUDIT_ACTION_INFO[action].humanOnly);
    expect(humanOnly).toEqual(["GATE_APPROVE", "GATE_REJECT"]);
  });

  it("states an outcome only where the action itself is a verdict", () => {
    const withOutcome = AuditAction.options.filter((action) => AUDIT_ACTION_INFO[action].outcome);
    expect(withOutcome).toEqual(["GATE_APPROVE", "GATE_REJECT", "SECURITY_SCAN_PASS", "SECURITY_SCAN_FAIL"]);
  });
});
