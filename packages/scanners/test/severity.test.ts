import type { ScanFinding, ScanSeverity } from "@maestro/contracts";
import { isScanBlocking } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import { SEVERITY_ORDER, blocksAt, countBySeverity, decideOutcome, severityRank } from "../src/index.js";

function finding(severity: ScanSeverity): ScanFinding {
  return { tool: "semgrep", severity, ruleId: "rule.id", message: "m" };
}

describe("severity threshold (M71 scan.block_level)", () => {
  it("orders severities from info to critical", () => {
    expect([...SEVERITY_ORDER]).toEqual(["info", "low", "medium", "high", "critical"]);
    expect(severityRank("critical")).toBeGreaterThan(severityRank("high"));
  });

  it("blocks at or above the configured level, never below", () => {
    expect(blocksAt("high", "high")).toBe(true);
    expect(blocksAt("critical", "high")).toBe(true);
    expect(blocksAt("medium", "high")).toBe(false);
  });

  it("fails when any finding reaches the threshold", () => {
    expect(decideOutcome([finding("low"), finding("high")], "high")).toBe("fail");
    expect(decideOutcome([finding("low"), finding("medium")], "high")).toBe("pass");
  });

  it("blocks on every finding when the threshold is the lowest severity", () => {
    expect(decideOutcome([finding("info")], "info")).toBe("fail");
  });

  it("passes an empty finding list at every threshold", () => {
    for (const level of SEVERITY_ORDER) expect(decideOutcome([], level)).toBe("pass");
  });

  it("counts findings per severity", () => {
    expect(countBySeverity([finding("low"), finding("low"), finding("critical")])).toEqual({
      info: 0,
      low: 2,
      medium: 0,
      high: 0,
      critical: 1,
    });
  });

  it("agrees with the contract: only pass is non-blocking", () => {
    expect(isScanBlocking("pass")).toBe(false);
    expect(isScanBlocking("fail")).toBe(true);
    expect(isScanBlocking("error")).toBe(true);
  });
});
