import { GitSha } from "@maestro/contracts";

/**
 * Branch name without the `refs/heads/` prefix. GitHub's `git/ref/{ref}`
 * endpoint wants `heads/<branch>` in the path and its `git/refs` create body
 * wants the fully-qualified `refs/heads/<branch>`, so the driver keeps a bare
 * branch name internally and adds the shape each call needs.
 */
export function toBranchName(ref: string): string {
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  if (ref.startsWith("heads/")) return ref.slice("heads/".length);
  return ref;
}

/** `refs/heads/<branch>` — the fully-qualified form GitHub's create-ref wants. */
export function toFullRef(branch: string): string {
  return `refs/heads/${toBranchName(branch)}`;
}

/** `heads/<branch>` — the form GitHub's get-a-reference path wants. */
export function toHeadsPath(branch: string): string {
  return `heads/${toBranchName(branch)}`;
}

/** True when the string is a full 40-character commit id. */
export function isFullSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** Validates a commit id against the shared GitSha contract, else null. */
export function toGitSha(value: unknown): GitSha | null {
  const parsed = GitSha.safeParse(value);
  return parsed.success ? parsed.data : null;
}
