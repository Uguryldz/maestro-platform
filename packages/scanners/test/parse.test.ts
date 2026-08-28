import { ScanFinding } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import { ScanParseError, parseGitleaks, parseSemgrep, parseTrivy } from "../src/index.js";
import { fixture } from "./helpers.js";

/**
 * Every fixture in this file is the VERBATIM stdout of a real container run —
 * gitleaks v8.30.1, semgrep 1.171.0, trivy 0.73.0 — against a workspace mounted
 * read-only at /workspace. See RAPOR.md §3 for the capture commands. The only
 * edit is in `gitleaks-report.json`, where `Secret` and `Match` are replaced
 * with `REDACTED-FOR-FIXTURE` (neither field is read by this package, and a
 * live-looking token committed here would be found by Maestro scanning itself).
 */
const CONTEXT = { secretSeverity: "critical" as const, mountPath: "/workspace" };

describe("gitleaks report parsing", () => {
  const parsed = parseGitleaks(fixture("gitleaks-report"), CONTEXT);

  it("maps every finding of the recorded report shape", () => {
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.findings[0]).toEqual({
      tool: "gitleaks",
      severity: "critical",
      ruleId: "stripe-access-token",
      file: "src/settings.js",
      line: 3,
      message: expect.stringContaining("Stripe Access Token"),
    });
    expect(parsed.findings[1]?.ruleId).toBe("github-pat");
  });

  it("strips the container mount prefix real gitleaks reports (B14)", () => {
    // The raw report says "/workspace/src/settings.js"; evidence must not mix
    // container-absolute paths with the repo-relative ones every other tool
    // and every reviewer uses.
    expect(fixture("gitleaks-report")).toContain('"File": "/workspace/src/settings.js"');
    expect(parsed.findings.map((finding) => finding.file)).toEqual(["src/settings.js", "src/settings.js"]);
  });

  it("grades secrets from configuration, since gitleaks reports no severity", () => {
    const low = parseGitleaks(fixture("gitleaks-report"), { ...CONTEXT, secretSeverity: "low" });

    expect(low.findings.map((f) => f.severity)).toEqual(["low", "low"]);
  });

  it("never copies the matched secret into a finding (M20/M34)", () => {
    const serialized = JSON.stringify(parsed.findings);

    expect(serialized).not.toContain("REDACTED-FOR-FIXTURE");
    expect(serialized).not.toContain("Secret");
    expect(serialized).not.toContain("Entropy");
  });

  it("treats [] and null (an empty Go slice) as a clean report", () => {
    expect(parseGitleaks("[]", CONTEXT).findings).toEqual([]);
    expect(parseGitleaks("null", CONTEXT).findings).toEqual([]);
  });

  it("refuses a report whose entries lack the fields it maps", () => {
    expect(() => parseGitleaks('[{"File":"a.ts"}]', CONTEXT)).toThrow(ScanParseError);
  });

  it("produces contract-valid findings", () => {
    for (const finding of parsed.findings) expect(ScanFinding.safeParse(finding).success).toBe(true);
  });
});

describe("semgrep report parsing", () => {
  const parsed = parseSemgrep(fixture("semgrep-results"), CONTEXT);

  it("prefers the rule author's metadata severity over the result level", () => {
    // extra.severity is ERROR, extra.metadata.severity is HIGH.
    expect(parsed.findings[0]?.ruleId).toBe("rules.bank.python.os-system");
    expect(parsed.findings[0]?.severity).toBe("high");
  });

  it("falls back to the semgrep level when the rule has no graded metadata", () => {
    // Live capture: `"metadata": {}` with `"severity": "INFO"`.
    expect(parsed.findings[1]?.ruleId).toBe("rules.bank.python.eval");
    expect(parsed.findings[1]?.severity).toBe("low");
  });

  it("maps path and start line, mount prefix removed", () => {
    expect(parsed.findings[0]?.file).toBe("src/deploy.py");
    expect(parsed.findings[0]?.line).toBe(5);
  });

  it("drops results semgrep itself marked as ignored", () => {
    // 1.171.0 removes `nosemgrep` matches from `results` outright rather than
    // flagging them, so this stays covered by a hand-built report for the
    // versions that do emit `is_ignored`.
    const report = JSON.stringify({
      results: [
        { check_id: "kept", path: "/workspace/a.py", start: { line: 1 }, extra: { message: "m", severity: "ERROR" } },
        {
          check_id: "suppressed", path: "/workspace/b.py", start: { line: 2 },
          extra: { message: "m", severity: "ERROR", is_ignored: true },
        },
      ],
      errors: [],
      paths: { scanned: ["/workspace/a.py", "/workspace/b.py"] },
    });

    expect(parseSemgrep(report, CONTEXT).findings.map((f) => f.ruleId)).toEqual(["kept"]);
  });

  it("treats an unknown severity label as serious, not as noise", () => {
    const report = JSON.stringify({
      results: [{ check_id: "r", path: "/workspace/a.ts", start: { line: 1 }, extra: { message: "m", severity: "BRAND_NEW" } }],
      paths: { scanned: ["/workspace/a.ts"] },
    });

    expect(parseSemgrep(report, CONTEXT).findings[0]?.severity).toBe("high");
  });

  it("reports a fatal when semgrep logged an error, even with zero findings", () => {
    const fatal = parseSemgrep(fixture("semgrep-fatal"), CONTEXT);

    expect(fatal.findings).toEqual([]);
    expect(fatal.fatal).toMatch(/semgrep reported 2 error/);
  });

  it("does not turn a warn-level entry into a fatal", () => {
    const report = JSON.stringify({
      results: [], errors: [{ level: "warn", message: "partially scanned" }],
      paths: { scanned: ["/workspace/a.ts"] },
    });

    expect(parseSemgrep(report, CONTEXT).fatal).toBeUndefined();
  });

  it("passes a clean run that actually looked at files", () => {
    const clean = parseSemgrep(fixture("semgrep-clean"), CONTEXT);

    expect(clean.findings).toEqual([]);
    expect(clean.fatal).toBeUndefined();
  });

  it("refuses to call a scan of ZERO files clean (B3)", () => {
    // Live capture against an empty mount: exit 0, no findings, no errors.
    const empty = parseSemgrep(fixture("semgrep-empty-workspace"), CONTEXT);

    expect(empty.fatal).toMatch(/scanned 0 files/);
  });

  it("refuses output without a results array or without paths", () => {
    expect(() => parseSemgrep('{"errors":[]}', CONTEXT)).toThrow(ScanParseError);
    expect(() => parseSemgrep('{"results":[],"errors":[]}', CONTEXT)).toThrow(ScanParseError);
  });
});

describe("trivy report parsing", () => {
  const parsed = parseTrivy(fixture("trivy-fs"), CONTEXT);

  it("flattens Results[].Vulnerabilities[] into findings", () => {
    expect(parsed.findings).toHaveLength(9);
    expect(parsed.findings[0]).toMatchObject({
      tool: "trivy",
      severity: "high",
      ruleId: "CVE-2020-8203",
      file: "package-lock.json",
    });
    expect(parsed.findings[0]?.message).toContain("lodash 4.17.15");
    expect(parsed.findings[0]?.message).toContain("fixed in 4.17.19");
  });

  it("keeps every severity the real report carried", () => {
    const counts = parsed.findings.reduce<Record<string, number>>((acc, finding) => {
      acc[finding.severity] = (acc[finding.severity] ?? 0) + 1;
      return acc;
    }, {});

    expect(counts).toEqual({ critical: 1, high: 4, medium: 4 });
  });

  it("does not park an UNKNOWN severity below every threshold", () => {
    const report = JSON.stringify({
      SchemaVersion: 2, ArtifactName: "/workspace",
      Results: [{ Target: "go.sum", Vulnerabilities: [{ VulnerabilityID: "GHSA-x", Severity: "UNKNOWN" }] }],
    });

    expect(parseTrivy(report, CONTEXT).findings[0]?.severity).toBe("medium");
  });

  it("accepts a clean report that omits Results entirely", () => {
    // Verified live: trivy 0.73.0 writes NO `Results` key for a tree with no
    // package manifest, so an empty `Results` cannot be the scope check.
    const clean = parseTrivy(fixture("trivy-clean"), CONTEXT);

    expect(clean.findings).toEqual([]);
    expect(clean.fatal).toBeUndefined();
  });

  it("refuses a vulnerability without an id", () => {
    const report = JSON.stringify({
      SchemaVersion: 2, ArtifactName: "/workspace",
      Results: [{ Target: "a", Vulnerabilities: [{ Severity: "HIGH" }] }],
    });

    expect(() => parseTrivy(report, CONTEXT)).toThrow(ScanParseError);
  });

  it("refuses any JSON that is not a trivy report (B2)", () => {
    // Each of these used to parse as a clean scan and pass the gate.
    for (const body of ['{}', '{"Results":null}', '{"error":"db unavailable"}', '{"Results":[]}']) {
      expect(() => parseTrivy(body, CONTEXT)).toThrow(ScanParseError);
    }
  });

  it("refuses a report about a different artifact than the mounted workspace (B3)", () => {
    const report = JSON.stringify({ SchemaVersion: 2, ArtifactName: "/tmp/somewhere-else", Results: [] });

    expect(parseTrivy(report, CONTEXT).fatal).toMatch(/but the workspace is mounted at/);
  });
});

describe("unreadable output is never an empty finding list", () => {
  const parsers = [
    ["gitleaks", (text: string) => parseGitleaks(text, CONTEXT)],
    ["semgrep", (text: string) => parseSemgrep(text, CONTEXT)],
    ["trivy", (text: string) => parseTrivy(text, CONTEXT)],
  ] as const;

  for (const [name, parse] of parsers) {
    it(`${name}: empty stdout and non-JSON both throw`, () => {
      expect(() => parse("")).toThrow(ScanParseError);
      expect(() => parse("   ")).toThrow(ScanParseError);
      expect(() => parse("panic: runtime error")).toThrow(ScanParseError);
      expect(() => parse('{"truncated": ')).toThrow(ScanParseError);
    });
  }
});
