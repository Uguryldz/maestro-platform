import { EvidenceFile, ScanResult, type ScanOutcome, type ScanTool } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import {
  SCAN_ERROR_RULE_ID,
  dedupeResults,
  scanEvidenceArtifacts,
  scanGateDecision,
  scanResultArtifact,
  scanSummaryArtifact,
  toEvidenceFile,
} from "../src/index.js";

function result(tool: ScanTool, outcome: ScanOutcome, findings: ScanResult["findings"] = []): ScanResult {
  return ScanResult.parse({
    tool,
    imageDigest: `sha256:${"7".repeat(64)}`,
    startedAt: "2026-08-08T10:00:00.000Z",
    finishedAt: "2026-08-08T10:00:30.000Z",
    findings,
    outcome,
  });
}

const CLEAN = [result("gitleaks", "pass"), result("semgrep", "pass"), result("trivy", "pass")];

describe("scan gate decision (M27)", () => {
  it("passes only when all three mandatory tools passed", () => {
    expect(scanGateDecision(CLEAN)).toMatchObject({ blocking: false, missing: [], blockingTools: [] });
  });

  it("blocks on a failed tool and names it", () => {
    const decision = scanGateDecision([
      CLEAN[0]!,
      CLEAN[1]!,
      result("trivy", "fail", [{ tool: "trivy", severity: "high", ruleId: "CVE-2020-8203", message: "lodash" }]),
    ]);

    expect(decision.blocking).toBe(true);
    expect(decision.blockingTools).toEqual(["trivy"]);
    expect(decision.reasons[0]).toMatch(/trivy: fail/);
  });

  it("blocks on an errored tool and repeats its reason", () => {
    const errored = result("semgrep", "error", [
      { tool: "semgrep", severity: "critical", ruleId: SCAN_ERROR_RULE_ID, message: "timed out after 900s" },
    ]);

    expect(scanGateDecision([CLEAN[0]!, errored, CLEAN[2]!]).reasons[0]).toMatch(/timed out after 900s/);
  });

  it("counts an optional org driver once it has run (M77)", () => {
    expect(scanGateDecision([...CLEAN, result("fortify", "fail")]).blockingTools).toEqual(["fortify"]);
    expect(scanGateDecision([...CLEAN, result("fortify", "pass")]).blocking).toBe(false);
  });
});

describe("evidence package output (M34)", () => {
  it("writes one file per tool plus a summary", () => {
    expect(scanEvidenceArtifacts(CLEAN).map((artifact) => artifact.name)).toEqual([
      "scan/gitleaks.json",
      "scan/semgrep.json",
      "scan/trivy.json",
      "scan/summary.md",
    ]);
  });

  it("stores the raw contract-shaped result, re-parseable by the contract", () => {
    const artifact = scanResultArtifact(CLEAN[0]!);

    expect(artifact.contentType).toBe("application/json");
    expect(ScanResult.parse(JSON.parse(artifact.body))).toEqual(CLEAN[0]);
  });

  it("summarises outcome, image digest and severity counts", () => {
    const body = scanSummaryArtifact([
      result("gitleaks", "fail", [
        { tool: "gitleaks", severity: "critical", ruleId: "aws-access-token", message: "leak" },
      ]),
      CLEAN[1]!,
      CLEAN[2]!,
    ]).body;

    expect(body).toContain("blocking: yes");
    expect(body).toContain(`| gitleaks | fail | sha256:${"7".repeat(64)} |`);
    expect(body).toMatch(/\| gitleaks \| fail \|[^\n]*\| 0 \| 0 \| 0 \| 0 \| 1 \|/);
    expect(body).toContain("## blocking");
  });

  it("shows a tool that never ran as MISSING and blocking", () => {
    const body = scanSummaryArtifact([CLEAN[0]!]).body;

    expect(body).toContain("| semgrep | MISSING |");
    expect(body).toContain("blocking: yes");
    expect(body).toContain("a required scan did not run");
  });

  it("says blocking: no only for a fully clean run", () => {
    expect(scanSummaryArtifact(CLEAN).body).toContain("blocking: no");
  });

  it("is deterministic — the same results always produce the same bytes", () => {
    expect(scanSummaryArtifact(CLEAN).body).toBe(scanSummaryArtifact(CLEAN).body);
  });

  it("produces a manifest entry the EvidencePackage contract accepts", () => {
    const artifact = scanSummaryArtifact(CLEAN);
    const file = toEvidenceFile(artifact);

    expect(EvidenceFile.safeParse(file).success).toBe(true);
    expect(file.bytes).toBe(Buffer.byteLength(artifact.body, "utf8"));
    expect(file.name).toBe("scan/summary.md");
  });

  it("hashes the exact bytes — against digests computed outside this package (B15)", () => {
    // Recomputing the implementation's own expression proves nothing; these two
    // come from `printf '…' | sha256sum`.
    const file = toEvidenceFile({ name: "scan/x.txt", contentType: "text/plain", body: "maestro" });

    expect(file.sha256).toBe("233e1cded61ace811d7a930947b06acb18cda1dc7b67e215941e1830fdec3b7c");
    expect(file.bytes).toBe(7);
    expect(toEvidenceFile({ name: "scan/y.txt", contentType: "text/plain", body: "" }).sha256).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("two results for one tool cannot become two evidence files (B7)", () => {
  const retried = [
    result("gitleaks", "pass"),
    result("gitleaks", "error", [
      { tool: "gitleaks", severity: "critical", ruleId: SCAN_ERROR_RULE_ID, message: "produced no output" },
    ]),
    CLEAN[1]!,
    CLEAN[2]!,
  ];

  it("keeps the most blocking result per tool", () => {
    expect(dedupeResults(retried).map((r) => [r.tool, r.outcome])).toEqual([
      ["gitleaks", "error"], ["semgrep", "pass"], ["trivy", "pass"],
    ]);
  });

  it("never emits the same evidence file name twice", () => {
    const names = scanEvidenceArtifacts(retried).map((artifact) => artifact.name);

    expect(names).toEqual(["scan/gitleaks.json", "scan/semgrep.json", "scan/trivy.json", "scan/summary.md"]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("summarises the result the gate decided on, not whichever came first", () => {
    const body = scanSummaryArtifact(retried).body;

    expect(body).toContain("blocking: yes");
    expect(body).toContain("| gitleaks | error |");
    expect(body).not.toContain("| gitleaks | pass |");
    expect(scanGateDecision(retried).blockingTools).toEqual(["gitleaks"]);
  });
});
