import { ScanResult, type ScanFinding, type ScanOutcome, type ScanTool } from "@maestro/contracts";

/**
 * Rule id of the synthetic finding carrying WHY a scan errored. `ScanResult` has
 * no message field, and an error with no findings reads exactly like a clean
 * pass — so the reason goes in a finding, namespaced where no tool can collide.
 */
export const SCAN_ERROR_RULE_ID = "maestro.scan-error";

const REASON_MAX = 500;

export interface ResultInput {
  tool: ScanTool;
  /** `sha256:…` for containers, a provenance string for API drivers (M77). */
  imageDigest: string;
  startedAt: Date;
  finishedAt: Date;
}

export function scanErrorFinding(tool: ScanTool, reason: string): ScanFinding {
  return { tool, severity: "critical", ruleId: SCAN_ERROR_RULE_ID, message: text(reason, "scan failed") };
}

/**
 * The only way this package says "no trustworthy verdict". Always
 * `outcome: "error"`, which `isScanBlocking` blocks on — there is no code path
 * from a failure to a `pass` (M27).
 */
export function errorResult(input: ResultInput & { reason: string }): ScanResult {
  return ScanResult.parse({
    tool: input.tool,
    imageDigest: text(input.imageDigest, "unknown"),
    startedAt: iso(input.startedAt),
    finishedAt: iso(input.finishedAt),
    findings: [scanErrorFinding(input.tool, input.reason)],
    outcome: "error" satisfies ScanOutcome,
  });
}

/**
 * Result of a scan that ran. If the assembled object violates the frozen
 * contract it becomes an error result — a malformed pass is still a pass to
 * everyone downstream, and that is the failure M27 forbids.
 */
export function completedResult(
  input: ResultInput & { findings: ScanFinding[]; outcome: Exclude<ScanOutcome, "error"> },
): ScanResult {
  const parsed = ScanResult.safeParse({
    tool: input.tool,
    imageDigest: text(input.imageDigest, ""),
    startedAt: iso(input.startedAt),
    finishedAt: iso(input.finishedAt),
    findings: input.findings,
    outcome: input.outcome,
  });
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return errorResult({ ...input, reason: `result does not satisfy the ScanResult contract — ${issues}` });
}

function text(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed.slice(0, REASON_MAX) : fallback;
}

/** An unusable clock must not be able to produce an unparseable result. */
function iso(value: Date): string {
  const time = value instanceof Date ? value.getTime() : Number.NaN;
  return new Date(Number.isFinite(time) ? time : 0).toISOString();
}
