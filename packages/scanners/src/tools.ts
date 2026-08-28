import type { ScanTarget } from "@maestro/ports";
import { reportPath, wrapCommand } from "./command.js";
import type { ContainerScanConfig, CoreScanTool } from "./config.js";
import { ScanConfigError } from "./errors.js";
import { parseGitleaks } from "./parse/gitleaks.js";
import { parseSemgrep } from "./parse/semgrep.js";
import { parseTrivy } from "./parse/trivy.js";
import type { ParseContext, ParsedScan } from "./parse/common.js";

export interface ToolSpec {
  tool: CoreScanTool;
  /**
   * Codes meaning "ran to completion". ANY other code is an `error` outcome even
   * when stdout happens to parse (M27): a half-dead scanner cleared nothing.
   */
  okExitCodes: readonly number[];
  /** Throws `ScanConfigError` for a target the tool cannot be pointed at. */
  argv(config: ContainerScanConfig, target: ScanTarget): string[];
  parse(stdout: string, context: ParseContext): ParsedScan;
  /** Factory-time check; runs before any container is started. */
  validate(config: ContainerScanConfig): void;
}

/** Refuses anything that could be read as a flag or a shell escape. */
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function gitRef(target: ScanTarget): string | undefined {
  const ref = target.diffBaseRef?.trim();
  if (!ref) return undefined;
  if (!SAFE_REF.test(ref)) throw new ScanConfigError(`diffBaseRef "${ref}" is not a plain git ref`);
  return ref;
}

const gitleaks: ToolSpec = {
  tool: "gitleaks",
  // Verified against v8.30.1: 0 = clean, 1 = leaks found, 2 = tool error.
  okExitCodes: [0, 1],
  argv(config, target) {
    const ref = gitRef(target);
    // `dir` / `git` replaced the (now undocumented) `detect` in v8.19+.
    const scope = ref
      ? ["git", config.workspaceMountPath, "--log-opts", `${ref}..HEAD`]
      : ["dir", config.workspaceMountPath];
    const report = reportPath("gitleaks");
    return wrapCommand(
      config.workspaceMountPath,
      ["gitleaks", ...scope, "--report-format", "json", "--report-path", report, ...config.extraArgs],
      { readReport: report },
    );
  },
  parse: (stdout, context) => parseGitleaks(stdout, context),
  validate: () => undefined,
};

const semgrep: ToolSpec = {
  tool: "semgrep",
  // Verified against 1.171.0: findings alone do NOT change the exit code (3
  // findings still exited 0); 1 only appears with `--error`, 7 is a config
  // failure. The verdict comes from the report, never from the code.
  okExitCodes: [0, 1],
  argv(config, target) {
    const ref = gitRef(target);
    return wrapCommand(config.workspaceMountPath, [
      // `--disable-version-check` is not cosmetic: measured against 1.171.0 on
      // an offline runner, semgrep spends 120 SECONDS on its version ping
      // before printing a report that took 0.8s to produce (4s with the flag).
      "semgrep", "scan", "--json", "--quiet", "--metrics=off", "--disable-version-check",
      "--config", config.rulesRef ?? "",
      ...(ref ? ["--baseline-commit", ref] : []), ...config.extraArgs, config.workspaceMountPath,
    ]);
  },
  parse: (stdout, context) => parseSemgrep(stdout, context),
  validate(config) {
    if (!config.rulesRef) {
      throw new ScanConfigError("semgrep: rulesRef is required — rules are pinned locally, never fetched at scan time");
    }
  },
};

const trivy: ToolSpec = {
  tool: "trivy",
  // Verified against 0.73.0: exits 0 whatever it finds unless `--exit-code` is
  // passed (which `extraArgs` refuses); a DB failure exits 1 with empty stdout.
  okExitCodes: [0],
  argv(config) {
    return wrapCommand(config.workspaceMountPath, [
      "trivy", "fs", "--format", "json", "--quiet", "--scanners", "vuln",
      ...config.extraArgs, config.workspaceMountPath,
    ]);
  },
  parse: (stdout, context) => parseTrivy(stdout, context),
  validate: () => undefined,
};

export const TOOL_SPECS: Record<CoreScanTool, ToolSpec> = { gitleaks, semgrep, trivy };
