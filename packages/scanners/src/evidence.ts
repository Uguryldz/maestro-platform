import { createHash } from "node:crypto";
import { EvidenceFile, isScanBlocking, type ScanResult, type ScanTool } from "@maestro/contracts";
import { CORE_SCAN_TOOLS } from "./config.js";
import { SCAN_ERROR_RULE_ID } from "./result.js";
import { countBySeverity, SEVERITY_ORDER } from "./severity.js";

/** Folder the scan evidence lands in inside the package (M34). */
export const SCAN_EVIDENCE_DIR = "scan";

export interface EvidenceArtifact {
  /** Path inside the evidence package. */ name: string;
  contentType: string;
  body: string;
}

export interface ScanGateDecision {
  blocking: boolean;
  /** Required tools with no result at all — the "we never ran it" case. */
  missing: ScanTool[];
  blockingTools: ScanTool[];
  reasons: string[];
}

/**
 * Two results for one tool must not become two evidence files with the same
 * name and different content, and the summary must not describe a different run
 * from the one the gate decided on. The most blocking result wins, so a retry
 * can never bury the failure it retried.
 */
const OUTCOME_WEIGHT: Record<string, number> = { pass: 0, fail: 1, error: 2 };

/** `isScanBlocking` stays the authority, so a future outcome outranks `pass` even unweighted. */
function severityOfOutcome(result: ScanResult): number {
  return (isScanBlocking(result.outcome) ? 10 : 0) + (OUTCOME_WEIGHT[result.outcome] ?? 0);
}

export function dedupeResults(results: readonly ScanResult[]): ScanResult[] {
  const byTool = new Map<ScanTool, ScanResult>();
  for (const result of results) {
    const kept = byTool.get(result.tool);
    if (!kept || severityOfOutcome(result) > severityOfOutcome(kept)) byTool.set(result.tool, result);
  }
  return [...byTool.values()];
}

/**
 * Whole-gate verdict (M27). A MISSING result blocks exactly like a failed one:
 * dropping a scanner from the wiring can never quietly open the gate.
 */
export function scanGateDecision(
  results: readonly ScanResult[],
  required: readonly ScanTool[] = CORE_SCAN_TOOLS,
): ScanGateDecision {
  const missing: ScanTool[] = [];
  const blockingTools: ScanTool[] = [];
  const reasons: string[] = [];
  const kept = dedupeResults(results);

  // An empty required set is a broken lookup, not "nothing is required": it
  // would open the gate with zero scans, which is exactly what M27 forbids.
  if (required.length === 0) {
    reasons.push("no required scan set was supplied — the gate cannot be evaluated");
  }
  if (kept.length === 0) {
    reasons.push("no scan results at all — nothing was scanned");
  }

  for (const tool of required) {
    if (!kept.some((result) => result.tool === tool)) {
      missing.push(tool);
      reasons.push(`${tool}: no result — a required scan did not run`);
    }
  }
  // Optional drivers (M77) are not required, but once they ran they count.
  for (const result of kept.filter((candidate) => isScanBlocking(candidate.outcome))) {
    blockingTools.push(result.tool);
    reasons.push(`${result.tool}: ${result.outcome}${detailOf(result)}`);
  }
  return {
    blocking: reasons.length > 0,
    missing,
    blockingTools,
    reasons,
  };
}

/** One file per tool: the raw, contract-shaped result (M34). */
export function scanResultArtifact(result: ScanResult): EvidenceArtifact {
  return {
    name: `${SCAN_EVIDENCE_DIR}/${result.tool}.json`,
    contentType: "application/json",
    body: `${JSON.stringify(result, null, 2)}\n`,
  };
}

/**
 * Summary sheet for the evidence package. Label-free on purpose: columns are
 * contract field names, so it needs no locale — prose is M104's job. Rows come
 * from the same de-duplicated set the gate decided on, so the sheet can never
 * describe a passing run while the gate blocks on a failing one.
 */
export function scanSummaryArtifact(
  results: readonly ScanResult[],
  required: readonly ScanTool[] = CORE_SCAN_TOOLS,
): EvidenceArtifact {
  const decision = scanGateDecision(results, required);
  const kept = dedupeResults(results);
  const lines = [
    "# scan-summary (M27)",
    "",
    `blocking: ${decision.blocking ? "yes" : "no"}`,
    "",
    `| tool | outcome | imageDigest | ${SEVERITY_ORDER.join(" | ")} |`,
    `|---|---|---|${SEVERITY_ORDER.map(() => "---").join("|")}|`,
  ];

  for (const tool of [...required, ...kept.map((r) => r.tool).filter((t) => !required.includes(t))]) {
    const result = kept.find((candidate) => candidate.tool === tool);
    if (!result) {
      lines.push(`| ${tool} | MISSING | - | ${SEVERITY_ORDER.map(() => "-").join(" | ")} |`);
      continue;
    }
    const counts = countBySeverity(result.findings);
    const cells = SEVERITY_ORDER.map((severity) => String(counts[severity])).join(" | ");
    lines.push(`| ${tool} | ${result.outcome} | ${result.imageDigest} | ${cells} |`);
  }

  if (decision.reasons.length > 0) {
    lines.push("", "## blocking", ...decision.reasons.map((reason) => `- ${reason}`));
  }
  return { name: `${SCAN_EVIDENCE_DIR}/summary.md`, contentType: "text/markdown", body: `${lines.join("\n")}\n` };
}

/** Every artifact of a run: one file per result plus the summary. */
export function scanEvidenceArtifacts(
  results: readonly ScanResult[],
  required: readonly ScanTool[] = CORE_SCAN_TOOLS,
): EvidenceArtifact[] {
  const artifacts = [
    ...dedupeResults(results).map(scanResultArtifact),
    scanSummaryArtifact(results, required),
  ];
  // A manifest with two entries called `scan/gitleaks.json` and different
  // digests is not evidence of anything; fail loudly instead of shipping it.
  const names = new Set(artifacts.map((artifact) => artifact.name));
  if (names.size !== artifacts.length) {
    throw new Error("scan evidence produced duplicate file names — refusing to build the package (M34)");
  }
  return artifacts;
}

function detailOf(result: ScanResult): string {
  const error = result.findings.find((finding) => finding.ruleId === SCAN_ERROR_RULE_ID);
  if (error) return ` — ${error.message}`;
  return result.findings.length > 0 ? ` — ${result.findings.length} finding(s)` : "";
}

/** Manifest entry (`EvidencePackage.files`) for an artifact. */
export function toEvidenceFile(artifact: EvidenceArtifact): EvidenceFile {
  return EvidenceFile.parse({
    name: artifact.name,
    sha256: createHash("sha256").update(artifact.body, "utf8").digest("hex"),
    bytes: Buffer.byteLength(artifact.body, "utf8"),
    contentType: artifact.contentType,
  });
}
