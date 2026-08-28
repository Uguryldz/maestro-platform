import type { ScanFinding, ScanOutcome, ScanSeverity } from "@maestro/contracts";

/** Ascending. Index is the rank used by every threshold comparison. */
export const SEVERITY_ORDER = ["info", "low", "medium", "high", "critical"] as const;

export function severityRank(severity: ScanSeverity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

/** True when `severity` is at or above the configured block level (M71). */
export function blocksAt(severity: ScanSeverity, blockLevel: ScanSeverity): boolean {
  return severityRank(severity) >= severityRank(blockLevel);
}

export function countBySeverity(findings: readonly ScanFinding[]): Record<ScanSeverity, number> {
  const counts = { info: 0, low: 0, medium: 0, high: 0, critical: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

/** Outcome of a scan that RAN. `error` is the driver's call, never this
 * function's: a crashed tool has no findings to threshold (M27). */
export function decideOutcome(
  findings: readonly ScanFinding[],
  blockLevel: ScanSeverity,
): Extract<ScanOutcome, "pass" | "fail"> {
  return findings.some((finding) => blocksAt(finding.severity, blockLevel)) ? "fail" : "pass";
}
