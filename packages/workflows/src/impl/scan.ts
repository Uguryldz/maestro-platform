import { isScanBlocking, type ScanResult, type ScanTool, type TicketKey } from "@maestro/contracts";
import { CORE_SCAN_TOOLS } from "@maestro/scanners";
import type { ActivityDeps } from "./deps.js";
import { audit, record } from "./record.js";

/**
 * Step 6b (M27): gitleaks + semgrep + trivy, fail-closed.
 *
 * "Fail-closed" is enforced twice on purpose. The port's contract says a driver
 * error is an `error` outcome; this activity additionally converts a THROWN
 * driver error into an `error` result rather than letting it escape, because an
 * activity that throws is retried and — after three attempts — fails the run
 * with no scan record at all. A scanner that cannot run must block the flow and
 * say so in the evidence package, not disappear from it (v1's defect was that
 * the scans were never called).
 */

/** The result recorded for a scanner that could not be run at all. */
export function scannerErrorResult(tool: ScanTool, at: string, message: string): ScanResult {
  return {
    tool,
    imageDigest: "unknown",
    startedAt: at,
    finishedAt: at,
    findings: [
      {
        tool,
        severity: "critical",
        ruleId: "maestro.scanner_unavailable",
        message: message.slice(0, 500),
      },
    ],
    outcome: "error",
  };
}

/**
 * `attempt` is what makes a round distinguishable.
 *
 * The idempotency key used to be derived from the RESULTS, so three laps of the
 * M54 loop that failed the same way collapsed into a single journal entry and a
 * single audit record — the evidence package then showed one scan where three
 * had run, which is exactly the artefact an auditor is handed. Keying on the
 * round instead keeps a genuine Temporal retry of the SAME round collapsed
 * (which is the guard's real job) while letting a new round write its own.
 */
export async function runScans(
  deps: ActivityDeps,
  ticket: TicketKey,
  attempt = 1,
): Promise<ScanResult[]> {
  const run = await deps.runs.get(ticket);
  const results: ScanResult[] = [];

  for (const tool of CORE_SCAN_TOOLS) {
    const startedAt = deps.now().toISOString();
    try {
      results.push(await deps.scan.run(tool, { workspacePath: run.workspacePath }));
    } catch (cause) {
      results.push(
        scannerErrorResult(tool, startedAt, cause instanceof Error ? cause.message : String(cause)),
      );
    }
  }

  const blocking = results.filter((result) => isScanBlocking(result.outcome));
  await audit(deps, run, {
    action: blocking.length === 0 ? "SECURITY_SCAN_PASS" : "SECURITY_SCAN_FAIL",
    meta: {
      tools: results.map((r) => `${r.tool}:${r.outcome}`),
      findings: results.reduce((sum, r) => sum + r.findings.length, 0),
    },
    key: `scan:${attempt}`,
  });
  await record(deps, run, {
    kind: "scan",
    title: blocking.length === 0 ? "tarama temiz" : "tarama bloke etti",
    detail: results.map((r) => `${r.tool}: ${r.outcome} (${r.findings.length})`).join(" · "),
    key: `scan:${attempt}`,
  });
  return results;
}
