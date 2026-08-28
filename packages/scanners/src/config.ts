import { ScanSeverity } from "@maestro/contracts";
import { z } from "zod";
import { parsePinnedImage } from "./image.js";

export const SCAN_PORT = "scan";

/** The mandatory trio (M27). The rest of `ScanTool` are optional org drivers (M77). */
export const CORE_SCAN_TOOLS = ["gitleaks", "semgrep", "trivy"] as const;
export type CoreScanTool = (typeof CORE_SCAN_TOOLS)[number];

/**
 * Threshold parameter key (M71); the value lives in the DB. The default here
 * mirrors `packages/db/src/params-defaults.ts` on purpose — a driver-local
 * default that disagrees with the platform one is the bug we are avoiding.
 */
export const SCAN_BLOCK_LEVEL_PARAM = "scan.block_level";
export const DEFAULT_BLOCK_LEVEL: ScanSeverity = "high";

const PinnedImageRef = z.string().trim().min(1).superRefine((value, ctx) => {
  try {
    parsePinnedImage(value);
  } catch (error) { ctx.addIssue({ code: "custom", message: (error as Error).message }); }
});

/** Absolute POSIX path the workspace is mounted at inside the container. */
const MountPath = z.string().trim().regex(/^\/[A-Za-z0-9._\-/]*$/, "must be an absolute POSIX path");

/**
 * Flags that change what the gate DECIDES rather than how the tool runs.
 * `scan.block_level` is a guarded, audited parameter (M71); a free-text
 * `extraArgs` that can reach the same outcome through `--severity NONE` or
 * `--skip-dirs /workspace` is the same decision with none of the guards, so the
 * whole family is refused. Anything not on this list still goes through.
 */
const FORBIDDEN_EXACT = new Set([
  "--severity", "--severities", "--exit-code", "--exit-on-severity", "--no-git", "--redact",
  "--config", "-c", "--format", "-f", "--json", "--output", "-o", "--report-format", "--report-path",
]);
const FORBIDDEN_PREFIXES = ["--skip", "--ignore", "--exclude", "--baseline", "--enable-rule", "--severity"];

/** `--severity=HIGH` and `--severity HIGH` are the same flag. */
export function forbiddenExtraArg(argument: string): string | undefined {
  const flag = argument.split("=", 1)[0]?.trim().toLowerCase() ?? "";
  if (!flag.startsWith("-")) return undefined;
  if (FORBIDDEN_EXACT.has(flag)) return flag;
  return FORBIDDEN_PREFIXES.find((prefix) => flag.startsWith(prefix));
}

/**
 * The same doors, reached through the environment. Every one of these tools
 * mirrors its flags into env vars, so banning `--severity` while allowing
 * `TRIVY_SEVERITY` would guard nothing. `TRIVY_DB_REPOSITORY` and the proxy
 * variables are deliberately still allowed — they say WHERE to fetch from, not
 * WHAT counts as a finding.
 */
const FORBIDDEN_ENV =
  /^(GITLEAKS_(CONFIG|ENABLE_)|TRIVY_(SEVERITY|IGNORE|EXIT_CODE|SKIP_DIRS|SKIP_FILES)|SEMGREP_(RULES|BASELINE|SEVERITY|EXCLUDE))/;

const ScanEnv = z
  .record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.string())
  .default({})
  .superRefine((value, ctx) => {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_ENV.test(key)) {
        ctx.addIssue({
          code: "custom",
          message: `env.${key} changes what the scan gate decides; use scan.block_level (M71)`,
        });
      }
    }
  });

const ExtraArgs = z.array(z.string().min(1)).default([]).superRefine((values, ctx) => {
  for (const value of values) {
    const flag = forbiddenExtraArg(value);
    if (flag) {
      ctx.addIssue({
        code: "custom",
        message: `extraArgs may not contain "${flag}" — it changes what the scan gate decides; use scan.block_level (M71)`,
      });
    }
  }
});

export const ContainerScanConfig = z.object({
  image: PinnedImageRef,
  /**
   * Lowest severity that blocks (M71 `scan.block_level`). Findings below it are
   * reported but do not fail the gate; an `error` outcome ignores it and always
   * blocks (M27).
   */
  blockLevel: ScanSeverity.default(DEFAULT_BLOCK_LEVEL),
  timeoutSeconds: z.number().int().positive().max(7_200).default(900),
  extraArgs: ExtraArgs,
  workspaceMountPath: MountPath.default("/workspace"),
  /** Offline by default; `internal` is for sites mirroring the trivy DB in-network. */
  networkMode: z.enum(["none", "internal"]).default("none"),
  env: ScanEnv,
  /** gitleaks reports no severity of its own; a detected secret is graded here. */
  secretSeverity: ScanSeverity.default("critical"),
  /** semgrep `--config`. Rules are never fetched at scan time — offline runners. */
  rulesRef: z.string().trim().min(1).optional(),
  /** stderr can echo matched source lines: an error result is not a disclosure channel. */
  includeStderrInError: z.boolean().default(false),
});
export type ContainerScanConfig = z.infer<typeof ContainerScanConfig>;
