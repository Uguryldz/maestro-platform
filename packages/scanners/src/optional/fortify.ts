import { ScanSeverity, type ScanFinding } from "@maestro/contracts";
import { CapabilityNotSupportedError } from "@maestro/ports";
import { z } from "zod";
import { DEFAULT_BLOCK_LEVEL, SCAN_PORT } from "../config.js";
import { ScanConfigError } from "../errors.js";
import { messageOr, optionalLine, optionalText, parseJson, parseWith, type ParsedScan } from "../parse/common.js";
import { HttpScanPort, depsOf, isUnconfigured, parseConfig, requireHttps, type FetchLike } from "./http-scan.js";
import type { Clock } from "../runner.js";

/**
 * Fortify SSC driver — M77, the one optional tool the bank already owns. Flow is
 * REPORT PULL: the scan is launched by the existing Fortify pipeline (ScanCentral
 * / fpr upload) and Maestro reads a project version's issue list. Endpoint, the
 * `FortifyToken` auth scheme and the envelope come from SSC's documented REST
 * API — TO BE VERIFIED against the bank's SSC version on access (RAPOR.md).
 */
export const FortifyConfig = z.object({
  /** SSC root, e.g. https://ssc.bank.local/ssc */
  baseUrl: z.url(),
  /** SSC project VERSION id (not the project id) whose issues are pulled. */
  projectVersionId: z.number().int().positive(),
  blockLevel: ScanSeverity.default(DEFAULT_BLOCK_LEVEL),
  pageLimit: z.number().int().positive().max(1_000).default(200),
  timeoutMs: z.number().int().positive().max(300_000).default(30_000),
});
export type FortifyConfig = z.infer<typeof FortifyConfig>;

/** The token is runtime material (SecretPort), never declarative config. */
export interface FortifyDeps {
  token?: string;
  fetchImpl?: FetchLike;
  clock?: Clock;
}

/** SSC list envelope: `{ data: [...], count, responseCode }`. */
const FortifyIssue = z.looseObject({
  issueName: z.string().optional(),
  /** Fortify Priority Order: Critical / High / Medium / Low. */
  friority: z.string().optional(),
  fullFileName: z.string().optional(),
  lineNumber: z.number().int().optional(),
  engineCategory: z.string().optional(),
  issueInstanceId: z.string().optional(),
});

/**
 * `data` is REQUIRED. With it optional an SSO or proxy page that answers 200
 * with any other JSON body — `{}` included — parsed as "no issues" and reported
 * a clean project. `count` is SSC's total across all pages and drives paging.
 */
const FortifyIssueList = z.looseObject({
  data: z.array(FortifyIssue),
  count: z.number().int().nonnegative().optional(),
  responseCode: z.number().int().optional(),
});

const FRIORITY: Record<string, ScanSeverity> =
  { CRITICAL: "critical", HIGH: "high", MEDIUM: "medium", LOW: "low" };

export function parseFortify(body: string): ParsedScan {
  const report = parseWith("fortify", FortifyIssueList, parseJson("fortify", body));
  if (report.responseCode !== undefined && report.responseCode !== 200) {
    return { findings: [], fatal: `fortify: SSC responseCode ${report.responseCode}` };
  }

  const findings: ScanFinding[] = report.data.map((issue) => ({
    tool: "fortify" as const,
    // An unmapped priority is treated as serious rather than filtered away.
    severity: FRIORITY[issue.friority?.toUpperCase() ?? ""] ?? "high",
    ruleId: messageOr("fortify.issue", issue.issueName, issue.engineCategory),
    file: optionalText(issue.fullFileName),
    line: optionalLine(issue.lineNumber),
    message: messageOr("fortify issue", issue.issueName, issue.engineCategory),
  }));
  return { findings, total: report.count, pageItems: report.data.length };
}

/**
 * @throws CapabilityNotSupportedError when Fortify is not configured (M77).
 * @throws ScanConfigError when it is configured but the configuration is wrong.
 */
export function createFortifyScanPort(input: unknown, deps: FortifyDeps = {}): HttpScanPort {
  if (isUnconfigured(input)) throw new CapabilityNotSupportedError(SCAN_PORT, "fortify");

  const config = parseConfig("fortify", FortifyConfig, input);
  const merged = { ...deps, ...depsOf<FortifyDeps>(input) };
  const token = merged.token?.trim();
  if (!token) throw new ScanConfigError("fortify: deps.token is required — SSC rejects anonymous reads");
  const baseUrl = requireHttps("fortify", config.baseUrl);

  return new HttpScanPort({
    spec: {
      tool: "fortify",
      provenance: `fortify-ssc:projectVersion/${config.projectVersionId}`,
      blockLevel: config.blockLevel,
      timeoutMs: config.timeoutMs,
      pageSize: config.pageLimit,
      url: (_target, page) =>
        `${baseUrl}/api/v1/projectVersions/${config.projectVersionId}/issues` +
        `?start=${page.offset}&limit=${config.pageLimit}&showhidden=false&showremoved=false&showsuppressed=false`,
      headers: () => ({ Authorization: `FortifyToken ${token}`, Accept: "application/json" }),
      parse: parseFortify,
    },
    fetchImpl: merged.fetchImpl,
    clock: merged.clock,
  });
}
