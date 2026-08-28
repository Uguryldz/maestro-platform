import type { ScanFinding, ScanSeverity } from "@maestro/contracts";
import { z } from "zod";
import { messageOr, parseJson, parseWith, repoPath, type ParseContext, type ParsedScan } from "./common.js";

/**
 * trivy `--format json`, shape captured from 0.73.0
 * (`fixtures/trivy-fs.json`): `{ SchemaVersion, ArtifactName, ArtifactType,
 * Results[] }`, each result `{ Target, Class, Type, Vulnerabilities[] }`.
 * `Results` is absent when no package manifest was found and `Vulnerabilities`
 * is absent (not `[]`) when a target is clean. Only `Vulnerabilities` is mapped
 * — `Secrets` (gitleaks' job here) and `Misconfigurations` are out of scope.
 *
 * `SchemaVersion` and `ArtifactName` are REQUIRED. They are what separates a
 * real trivy report from any other JSON: with them optional, `{}` and even
 * `{"error":"db unavailable"}` parsed as a clean scan and passed the gate.
 */
const TrivyVulnerability = z.looseObject({
  VulnerabilityID: z.string().min(1),
  PkgName: z.string().optional(),
  InstalledVersion: z.string().optional(),
  FixedVersion: z.string().optional(),
  Title: z.string().optional(),
  Severity: z.string().optional(),
});

const TrivyResult = z.looseObject({
  Target: z.string().optional(),
  Vulnerabilities: z.array(TrivyVulnerability).nullish(),
});

const TrivyReport = z.looseObject({
  SchemaVersion: z.number().int(),
  ArtifactName: z.string().min(1),
  Results: z.array(TrivyResult).nullish(),
});

const TRIVY_SEVERITY: Record<string, ScanSeverity> =
  { CRITICAL: "critical", HIGH: "high", MEDIUM: "medium", LOW: "low" };

/**
 * `UNKNOWN` means no source rated the CVE, not that it is harmless: mapping it
 * to `info` would park every unrated vulnerability below any threshold.
 */
const UNRATED_SEVERITY: ScanSeverity = "medium";

export function trivySeverity(value: string | undefined): ScanSeverity {
  return TRIVY_SEVERITY[value?.toUpperCase() ?? ""] ?? UNRATED_SEVERITY;
}

export function parseTrivy(stdout: string, context: ParseContext): ParsedScan {
  const report = parseWith("trivy", TrivyReport, parseJson("trivy", stdout));

  const findings: ScanFinding[] = [];
  for (const result of report.Results ?? []) {
    for (const vulnerability of result.Vulnerabilities ?? []) {
      findings.push({
        tool: "trivy",
        severity: trivySeverity(vulnerability.Severity),
        ruleId: vulnerability.VulnerabilityID,
        file: repoPath(result.Target, context.mountPath),
        message: describe(vulnerability),
      });
    }
  }

  // Scope proof. trivy legitimately reports NO `Results` for a source tree with
  // no package manifest (verified live on 0.73.0), so an empty `Results` cannot
  // be the check — but `ArtifactName` always names what was scanned, and a
  // report about some other artifact says nothing about this workspace.
  if (report.ArtifactName !== context.mountPath) {
    return {
      findings,
      fatal: `trivy scanned "${report.ArtifactName}" but the workspace is mounted at "${context.mountPath}"`,
    };
  }
  return { findings };
}

function describe(vulnerability: z.infer<typeof TrivyVulnerability>): string {
  const pkg = [vulnerability.PkgName, vulnerability.InstalledVersion].filter(Boolean).join(" ");
  const fix = vulnerability.FixedVersion ? ` (fixed in ${vulnerability.FixedVersion})` : "";
  const title = messageOr(vulnerability.VulnerabilityID, vulnerability.Title);
  return pkg ? `${pkg}: ${title}${fix}` : `${title}${fix}`;
}
