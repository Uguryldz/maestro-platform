import type { ScanFinding } from "@maestro/contracts";
import { z } from "zod";
import { messageOr, optionalLine, parseJson, parseWith, repoPath, type ParseContext, type ParsedScan } from "./common.js";

/**
 * gitleaks v8 JSON report (`--report-format json`): a flat array with PascalCase
 * keys. Only the mapped fields are required; the rest (Author, Email, Date,
 * Message, Fingerprint, Link, …) is tolerated so an upgrade does not error every
 * scan. `Secret`, `Match` and `Entropy` are deliberately NOT read — copying the
 * matched secret into a result republishes it in evidence and Jira (M20/M34).
 */
const GitleaksFinding = z.looseObject({
  RuleID: z.string().min(1),
  Description: z.string().optional(),
  File: z.string().optional(),
  StartLine: z.number().int().optional(),
  Commit: z.string().optional(),
});

/**
 * Go marshals an empty finding slice as `null`, so both `[]` and `null` are
 * real "clean scan" reports.
 */
const GitleaksReport = z.union([z.array(GitleaksFinding), z.null()]);

export function parseGitleaks(stdout: string, context: ParseContext): ParsedScan {
  const report = parseWith("gitleaks", GitleaksReport, parseJson("gitleaks", stdout)) ?? [];

  const findings: ScanFinding[] = report.map((entry) => ({
    tool: "gitleaks" as const,
    // gitleaks grades nothing: every hit is "a secret is in the tree", and how
    // hard that stops the flow is a configured decision (see secretSeverity).
    severity: context.secretSeverity,
    ruleId: entry.RuleID,
    file: repoPath(entry.File, context.mountPath),
    line: optionalLine(entry.StartLine),
    message: messageOr(`secret detected by rule ${entry.RuleID}`, entry.Description),
  }));

  return { findings };
}
