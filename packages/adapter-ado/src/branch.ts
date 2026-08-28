import { GitSha, TicketKey } from "@maestro/contracts";

/** Git ref name for a branch, tolerating an already-qualified input. */
export function toRefName(branch: string): string {
  return branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
}

/** Branch name without the `refs/heads/` prefix. */
export function toBranchName(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

/** "Create this ref" is expressed as an update from the all-zero object id. */
export const ZERO_OBJECT_ID = "0".repeat(40);

/** True when the string is a full 40-character commit id. */
export function isFullSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** Branch naming convention of the trunk-based flow (M49). */
const FEATURE_BRANCH = /^feature\/([A-Z][A-Z0-9]+-\d+)(?:-.*)?$/;

/**
 * Extracts the Jira ticket key from a branch name or ref (M49:
 * `feature/UGURPAY-123-short-name`).
 *
 * Returns null when the branch does not follow the convention — release
 * branches, `main`, hotfix branches or hand-made branches. A null is a
 * deliberate "not a Maestro branch" answer: callers must ignore the event
 * instead of guessing a key, because a wrong key would signal the wrong
 * workflow run.
 */
export function extractTicketKey(branchOrRef: string): TicketKey | null {
  const match = FEATURE_BRANCH.exec(toBranchName(branchOrRef.trim()));
  const candidate = match?.[1];
  if (candidate === undefined) return null;
  const parsed = TicketKey.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** Pull request id encoded in a `refs/pull/<id>/merge` ref, else null. */
export function extractPullRequestId(ref: string): number | null {
  const match = /^refs\/pull\/(\d+)\/(?:merge|head)$/.exec(ref.trim());
  const raw = match?.[1];
  if (raw === undefined) return null;
  const id = Number.parseInt(raw, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Validates a commit id against the shared GitSha contract, else null. */
export function toGitSha(value: unknown): GitSha | null {
  const parsed = GitSha.safeParse(value);
  return parsed.success ? parsed.data : null;
}
