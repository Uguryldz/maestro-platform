import { normalizeRepoPath } from "./protected-paths.js";
import type { ChangedFile, ChangeStatus } from "./types.js";

/**
 * `git status --porcelain=v1 -z` and `git diff --numstat -z`, parsed.
 *
 * Pure functions over the bytes the sandbox printed, so the parsing rules —
 * which are where a probe silently loses a change — are testable without a
 * runner, a container or a repository.
 *
 * `-z` rather than the default line format is not a detail. Porcelain v1
 * quotes and backslash-escapes any path containing a space, a quote or a
 * non-ASCII byte, so a line-oriented parser has to unquote correctly or it
 * reports a path that does not exist — and a path that does not exist matches
 * no deny-list pattern. `-z` emits raw bytes with NUL separators and no
 * quoting at all, which removes that class of bug rather than handling it.
 */

/** Porcelain XY codes → the states M52 reasons about. */
function statusOf(code: string): ChangeStatus {
  // Index and worktree halves; the worktree half wins when both are set,
  // except for a rename, which only ever appears in the index half.
  if (code.includes("R")) return "renamed";
  if (code.includes("T")) return "typechange";
  if (code.includes("D")) return "deleted";
  if (code.includes("A") || code.includes("?")) return "added";
  return "modified";
}

/**
 * Splits a NUL-delimited porcelain v1 stream into entries.
 *
 * A rename entry spends TWO NUL-separated fields — `R  <new>\0<old>\0` — so
 * the reader cannot simply split and map. Getting this wrong shifts every
 * subsequent entry by one field, which turns the rest of the diff into
 * nonsense paths that match nothing.
 */
export function parsePorcelainZ(stdout: string): ChangedFile[] {
  const fields = stdout.split("\0");
  const files: ChangedFile[] = [];

  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i];
    // A trailing NUL leaves an empty final field; short fragments cannot carry
    // the two status characters plus a space.
    if (entry === undefined || entry.length < 4) continue;

    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    const status = statusOf(code);

    if (status === "renamed") {
      // The ORIGIN is the next field. Both ends are recorded: a rename is the
      // cheapest way to move content onto (or off) protected ground, and a
      // matcher that only sees the destination misses half of it.
      const fromPath = fields[i + 1];
      i += 1;
      files.push({
        path: normalizeRepoPath(path),
        status,
        ...(fromPath === undefined || fromPath.length === 0
          ? {}
          : { fromPath: normalizeRepoPath(fromPath) }),
        insertions: 0,
        deletions: 0,
      });
      continue;
    }

    files.push({ path: normalizeRepoPath(path), status, insertions: 0, deletions: 0 });
  }
  return files;
}

/**
 * `git diff --numstat -z` → line counts per path.
 *
 * Separate from the status parse because numstat covers only tracked, textual
 * changes: an untracked file has no numstat row, and a binary one reports `-`.
 * Both legitimately mean "no line counts", never "no change", so the counts
 * are merged ONTO the status list rather than replacing it — a probe built the
 * other way round reports an untracked `.github/workflows/deploy.yml` as
 * nothing at all.
 */
export function parseNumstatZ(stdout: string): Map<string, { insertions: number; deletions: number }> {
  const counts = new Map<string, { insertions: number; deletions: number }>();
  const fields = stdout.split("\0");

  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (field === undefined || field.length === 0) continue;
    // `<ins>\t<del>\t<path>` — or, for a rename, `<ins>\t<del>\t` with the old
    // and new paths following as their own NUL-separated fields.
    const parts = field.split("\t");
    if (parts.length < 3) continue;

    const insertions = numberOf(parts[0]);
    const deletions = numberOf(parts[1]);
    let path = parts[2] ?? "";
    if (path.length === 0) {
      // Rename form: the next two fields are the old and the new path, and the
      // counts belong to the NEW one.
      path = fields[i + 2] ?? "";
      i += 2;
    }
    if (path.length === 0) continue;
    counts.set(normalizeRepoPath(path), { insertions, deletions });
  }
  return counts;
}

/** `-` is git's "binary file"; it is not zero lines, but it is zero LINES. */
function numberOf(raw: string | undefined): number {
  if (raw === undefined || raw === "-") return 0;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : 0;
}

/** Merges numstat counts onto the status list, keeping every status entry. */
export function mergeCounts(
  files: readonly ChangedFile[],
  counts: Map<string, { insertions: number; deletions: number }>,
): ChangedFile[] {
  return files.map((file) => {
    const count = counts.get(file.path);
    return count === undefined ? file : { ...file, ...count };
  });
}

/**
 * Everything under `.git/` the session left behind, from `find`'s output.
 *
 * Reported as `added`/`modified` on a best-effort basis: the point is not an
 * accurate diff of git's internals, it is that the M52 gate SEES a file
 * appear at `.git/hooks/post-checkout`. A hook dropped there is persistent
 * code execution on the bank's runner that no `git status` will ever mention.
 */
export function parseInternalPaths(stdout: string, prefix = ".git/"): ChangedFile[] {
  return stdout
    .split("\0")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => normalizeRepoPath(line.startsWith(prefix) ? line : `${prefix}${line}`))
    .map((path) => ({ path, status: "modified" as const, insertions: 0, deletions: 0 }));
}
