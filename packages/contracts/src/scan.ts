import { z } from "zod";
import { IsoDateTime, NonEmpty } from "./common.js";

/** Core trio is mandatory; the rest are optional org drivers (M27/M77). */
export const ScanTool = z.enum(["gitleaks", "semgrep", "trivy", "sonarqube", "fortify", "xray"]);
export type ScanTool = z.infer<typeof ScanTool>;

export const ScanSeverity = z.enum(["info", "low", "medium", "high", "critical"]);
export type ScanSeverity = z.infer<typeof ScanSeverity>;

export const ScanFinding = z.object({
  tool: ScanTool,
  severity: ScanSeverity,
  ruleId: NonEmpty,
  file: NonEmpty.optional(),
  line: z.number().int().positive().optional(),
  message: NonEmpty,
});
export type ScanFinding = z.infer<typeof ScanFinding>;

export const ScanOutcome = z.enum(["pass", "fail", "error"]);
export type ScanOutcome = z.infer<typeof ScanOutcome>;

/** Scanner images are digest-pinned (M27). */
export const ScanResult = z.object({
  tool: ScanTool,
  imageDigest: NonEmpty,
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime,
  findings: z.array(ScanFinding).default([]),
  outcome: ScanOutcome,
});
export type ScanResult = z.infer<typeof ScanResult>;

/** M27 fail-closed: anything that is not a clean pass blocks the flow. */
export function isScanBlocking(outcome: z.infer<typeof ScanOutcome>): boolean {
  return outcome !== "pass";
}
