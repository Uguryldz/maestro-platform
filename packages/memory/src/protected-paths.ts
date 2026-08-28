/**
 * `protected_paths` (M52) matching.
 *
 * The deny-list lives in the repo's `.maestro.yaml` (M71) and the workflow
 * stops when the AI produces a diff that touches it. Memory needs the same
 * matcher because the bootstrap package must warn a resumed session about the
 * paths it may not touch — a warning is worthless if it does not use the rule
 * the gate will actually apply.
 */

/** M52: migrations and secret material are protected unless a repo says otherwise. */
export const DEFAULT_PROTECTED_PATHS: readonly string[] = [
  "**/migrations/**",
  "**/secrets/**",
  "**/.env*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
];

/** Strip the spellings of "the repo root" so both sides compare equal. */
export function normalisePath(path: string): string {
  let out = path.trim().replace(/\\/g, "/");
  while (out.startsWith("./")) out = out.slice(2);
  while (out.startsWith("/")) out = out.slice(1);
  return out;
}

const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g;

/**
 * Glob → RegExp. `**` crosses directory separators, `*` and `?` do not; a
 * pattern with no wildcard also matches everything beneath it, so
 * `db/migrations` covers `db/migrations/0001.sql` without the author having to
 * think about it.
 */
function toRegExp(pattern: string): RegExp | undefined {
  const cleaned = normalisePath(pattern);
  if (cleaned.length === 0) return undefined;
  const directoryOnly = cleaned.endsWith("/");
  const body = directoryOnly ? cleaned.slice(0, -1) : cleaned;

  let source = "";
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i] as string;
    if (char === "*") {
      if (body[i + 1] === "*") {
        // `**/` may also match nothing, so `**/x` matches a top-level `x`.
        if (body[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += char.replace(REGEX_SPECIALS, "\\$&");
  }

  const hasWildcard = body.includes("*") || body.includes("?");
  const suffix = directoryOnly ? "/.*" : hasWildcard ? "" : "(?:/.*)?";
  return new RegExp(`^${source}${suffix}$`);
}

export interface CompiledProtectedPaths {
  readonly patterns: readonly string[];
  /** First pattern that claims `file`, or undefined. */
  match(file: string): string | undefined;
}

export function compileProtectedPaths(patterns: readonly string[]): CompiledProtectedPaths {
  const compiled: { pattern: string; regex: RegExp }[] = [];
  for (const pattern of patterns) {
    const regex = toRegExp(pattern);
    if (regex !== undefined) compiled.push({ pattern, regex });
  }
  return {
    patterns: compiled.map((entry) => entry.pattern),
    match(file: string): string | undefined {
      const path = normalisePath(file);
      if (path.length === 0) return undefined;
      return compiled.find((entry) => entry.regex.test(path))?.pattern;
    },
  };
}

export interface ProtectedPathHit {
  readonly file: string;
  readonly pattern: string;
}

/** Every changed file that a protected pattern claims, in input order. */
export function protectedPathHits(
  files: readonly string[],
  patterns: readonly string[],
): ProtectedPathHit[] {
  const compiled = compileProtectedPaths(patterns);
  const hits: ProtectedPathHit[] = [];
  for (const file of files) {
    const pattern = compiled.match(file);
    if (pattern !== undefined) hits.push({ file, pattern });
  }
  return hits;
}
