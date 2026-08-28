import { ToolPolicyError } from "./errors.js";
import { isUnreadablePath } from "./workspace-path.js";

/**
 * The search half of the sandbox gate (verifier B5).
 *
 * `search_workspace` was the one tool of four that reached its driver with no
 * path check at all: `{ glob: "../../**\/*.pem" }` came back `{"status":"ok"}`.
 * A search is a read with a pattern instead of a path, so it answers to the
 * same two questions — may this pattern leave the workspace, and may these hits
 * come back to the model.
 *
 * Two independent controls, because they fail differently:
 *  · `assertSearchGlob` refuses a pattern that would leave the sandbox, BEFORE
 *    the driver sees it. This is the one that stops the request.
 *  · `redactSearchHits` drops results on secret paths AFTER the driver answers.
 *    The `WorkspaceFs` contract makes the filter the driver's obligation too,
 *    but a boundary that trusts its driver is not a boundary: a driver written
 *    against an older contract, or a `grep -r` shelled out with the glob passed
 *    through, must not be able to hand a private key back through this tool.
 */

/** A glob may say `*`, `?`, `/` and ordinary path characters. Nothing else. */
const GLOB_SEGMENT = /^[A-Za-z0-9._*?[\]{},!+@()|^$-]*$/;

function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Refuses a glob that could match outside the workspace. Deliberately checked
 * on the RAW pattern rather than on a normalised one: `normalizeRepoPath`
 * collapses `./` and would have to be taught what `**` means, and a glob that
 * needs interpreting to be judged safe is a glob that will be interpreted
 * differently by the driver.
 */
export function assertSearchGlob(tool: string, glob: string): string {
  const trimmed = glob.trim();
  if (trimmed === "") {
    throw new ToolPolicyError(tool, "glob_escape", `${tool}: an empty glob is not a filter`);
  }
  if (hasControlChars(trimmed)) {
    // A NUL truncates the pattern at the syscall boundary, so the driver would
    // see a shorter — and possibly much broader — pattern than the one judged.
    throw new ToolPolicyError(tool, "glob_escape", `${tool}: glob contains control characters`);
  }
  const unified = trimmed.replace(/\\/g, "/");
  if (unified.startsWith("/") || /^[A-Za-z]:/.test(unified)) {
    throw new ToolPolicyError(
      tool,
      "glob_escape",
      `${tool}: glob "${glob}" is absolute; search patterns are workspace-relative`,
    );
  }
  const segments = unified.split("/");
  if (segments.includes("..")) {
    throw new ToolPolicyError(
      tool,
      "glob_escape",
      `${tool}: glob "${glob}" escapes the sandbox workspace`,
    );
  }
  if (unified.startsWith("~")) {
    // `~` is the caller's home on the runner, i.e. outside the workspace and
    // exactly where an SSH key lives.
    throw new ToolPolicyError(tool, "glob_escape", `${tool}: glob "${glob}" refers to a home directory`);
  }
  for (const segment of segments) {
    if (!GLOB_SEGMENT.test(segment)) {
      throw new ToolPolicyError(
        tool,
        "glob_escape",
        `${tool}: glob "${glob}" uses characters a workspace search does not accept`,
      );
    }
  }
  return unified;
}

/**
 * Drops hits whose path is on the read-and-write deny-list (B6). A hit is
 * content — `text` is a line out of the file — so a search that matched inside
 * `tls/server.key` would return the key material itself.
 */
export function redactSearchHits<T extends { readonly path: string }>(hits: readonly T[]): readonly T[] {
  return hits.filter((hit) => !isUnreadablePath(hit.path));
}
