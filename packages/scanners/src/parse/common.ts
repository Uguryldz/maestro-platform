import type { ScanFinding, ScanSeverity } from "@maestro/contracts";
import type { z } from "zod";
import { ScanParseError } from "../errors.js";

export interface ParsedScan {
  findings: ScanFinding[];
  /** The tool reported it could not complete — the driver makes it `error` (M27). */
  fatal?: string;
  /**
   * Paged HTTP reports only (M77): how many items the server says exist in
   * total, and how many this page carried. Without them a driver that reads
   * page 1 of 25 reports a clean project because the Criticals were on page 2.
   */
  total?: number;
  pageItems?: number;
}

/** Everything a parser needs from configuration. */
export interface ParseContext {
  secretSeverity: ScanSeverity;
  /**
   * Where the workspace is mounted inside the container. Real tools report
   * container-absolute paths (`/workspace/src/settings.js`, verified live), and
   * an evidence package that mixes those with repo-relative paths is unreadable
   * to a reviewer — so the prefix is stripped here, in one place.
   */
  mountPath: string;
}

/** `/workspace/src/a.js` → `src/a.js`; anything outside the mount is left alone. */
export function repoPath(value: string | undefined, mountPath: string): string | undefined {
  const text = optionalText(value);
  if (text === undefined) return undefined;
  const prefix = mountPath.replace(/\/+$/, "");
  if (prefix === "" || !text.startsWith(`${prefix}/`)) return text === prefix ? undefined : text;
  return optionalText(text.slice(prefix.length + 1));
}

/**
 * Every parser starts here: unreadable output is an exception, never an empty
 * finding list. "It produced nothing, so it passed" is what M27 forbids.
 */
export function parseJson(tool: string, stdout: string): unknown {
  const text = stdout.trim();
  if (text === "") throw new ScanParseError(`${tool}: produced no output — nothing to interpret`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ScanParseError(`${tool}: output is not JSON — ${(error as Error).message}`);
  }
}

export function parseWith<T>(tool: string, schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new ScanParseError(`${tool}: report does not match the expected schema — ${issues}`);
}

/** `ScanFinding.message` is a non-empty string; tools do not always fill theirs. */
export function messageOr(fallback: string, ...candidates: (string | undefined)[]): string {
  for (const candidate of candidates) {
    const text = candidate?.trim();
    if (text) return text;
  }
  return fallback;
}

export function optionalText(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text === "" ? undefined : text;
}

/** `ScanFinding.line` is a positive integer; 0 means "the tool did not say". */
export function optionalLine(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
