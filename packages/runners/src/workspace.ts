import { createHash } from "node:crypto";
import { GitSha, PlatformProfile } from "@maestro/contracts";
import { z } from "zod";
import { RunnerKeyError } from "./errors.js";

/**
 * Workspace + cache naming (M31 three cache layers, M65 lifecycle).
 *
 * Every function here is PURE and total: same input, same name, no I/O. Names
 * are what the audit trail and the disk both point at, so they must be
 * reproducible from the ticket alone — a run that cannot recompute the name of
 * its own workspace cannot resume into it (M30).
 */

/** Where the job's workspace volume is mounted inside the container. */
export const WORKSPACE_MOUNT_PATH = "/workspace";

/** Parent of every dependency cache mount (layer ① of M31). */
export const CACHE_MOUNT_ROOT = "/cache";

/** Docker object names: `[a-zA-Z0-9][a-zA-Z0-9_.-]*`. */
const DOCKER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

const MAX_KEY_LENGTH = 200;
const SLUG_LENGTH = 32;
const HASH_LENGTH = 12;

/**
 * Workspace key grammar. The key comes from the workflow (`RunJob.workspaceKey`,
 * typically `<TICKET>` or `<TICKET>/<branch>`), so it may contain `/` — but
 * nothing that could walk out of a path or smuggle a shell/CLI flag.
 */
export function assertWorkspaceKey(key: string): void {
  if (key.length === 0) throw new RunnerKeyError(key, "empty");
  if (key.length > MAX_KEY_LENGTH) throw new RunnerKeyError(key, `longer than ${MAX_KEY_LENGTH} characters`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(key)) {
    throw new RunnerKeyError(key, "must start alphanumeric and contain only [A-Za-z0-9._/-]");
  }
  if (key.endsWith("/")) throw new RunnerKeyError(key, "must not end with '/'");
  if (key.includes("//")) throw new RunnerKeyError(key, "must not contain an empty segment");
  if (key.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new RunnerKeyError(key, "must not contain '.' or '..' segments");
  }
}

/** Cache keys are single segments: they become one directory under /cache. */
export function assertCacheKey(key: string): void {
  if (key.length === 0) throw new RunnerKeyError(key, "empty");
  if (key.length > MAX_KEY_LENGTH) throw new RunnerKeyError(key, `longer than ${MAX_KEY_LENGTH} characters`);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(key)) {
    throw new RunnerKeyError(key, "must be a single lowercase segment matching [a-z0-9][a-z0-9._-]*");
  }
  if (key.includes("..")) throw new RunnerKeyError(key, "must not contain '..'");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Canonical form of a workspace key. The FIRST segment is the ticket id, which
 * is case-insensitive by definition (Jira stores it upper-case), so
 * "ugurpay-1042" and "UGURPAY-1042" must name one workspace — otherwise the
 * same ticket resumes into two volumes and M30 loses the session that held its
 * context. Everything after it is a branch path and stays case-SENSITIVE: git
 * allows `feature/Foo` and `feature/foo` side by side, and folding those
 * together would put two working trees in one workspace.
 */
export function canonicalWorkspaceKey(key: string): string {
  const [ticket = "", ...rest] = key.split("/");
  return [ticket.toUpperCase(), ...rest].join("/");
}

/**
 * Sanitised, length-capped prefix + a hash of the WHOLE key. The slug is for
 * humans reading `docker volume ls`; the hash is what makes the mapping
 * injective, so two tickets can never collide on one workspace.
 */
function volumeName(prefix: string, key: string): string {
  const slug = key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, SLUG_LENGTH);
  const digest = sha256Hex(key).slice(0, HASH_LENGTH);
  const name = slug.length > 0 ? `${prefix}-${slug}-${digest}` : `${prefix}-${digest}`;
  /* c8 ignore next -- unreachable: prefix and digest are both [a-z0-9] by construction */
  if (!DOCKER_NAME.test(name)) throw new RunnerKeyError(key, "does not produce a valid docker volume name");
  return name;
}

/** Volume holding layer ② of M31: the ticket workspace (clone + build + session). */
export function workspaceVolumeName(workspaceKey: string, prefix = "maestro-ws"): string {
  assertWorkspaceKey(workspaceKey);
  return volumeName(prefix, canonicalWorkspaceKey(workspaceKey));
}

/** Volume holding layer ① of M31: the shared dependency cache. */
export function cacheVolumeName(cacheKey: string, prefix = "maestro-cache"): string {
  assertCacheKey(cacheKey);
  return volumeName(prefix, cacheKey);
}

/** Mount point of one dependency cache inside the container. */
export function cacheMountPath(cacheKey: string): string {
  assertCacheKey(cacheKey);
  return `${CACHE_MOUNT_ROOT}/${cacheKey}`;
}

const DependencyCacheInput = z.object({
  platform: PlatformProfile,
  /** Package manager / toolchain the cache belongs to (npm, gradle, nuget…). */
  tool: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  /** Repository identity — the cache is shared per repo, not per ticket. */
  repo: z.string().trim().min(1).max(200),
  /** Digest of the lockfile that pins the dependency set. */
  lockfileHash: GitSha.or(z.string().regex(/^[0-9a-f]{64}$/)),
});
export type DependencyCacheInput = z.input<typeof DependencyCacheInput>;

/**
 * Layer ① key (M31): repo + lockfile. Deliberately NOT ticket-scoped — two
 * tickets on the same lockfile must hit the same cache — and it changes the
 * moment the lockfile does, so a stale dependency set can never be reused.
 */
export function dependencyCacheKey(input: DependencyCacheInput): string {
  const parsed = DependencyCacheInput.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new RunnerKeyError(String(input.repo ?? ""), issues);
  }
  const { platform, tool, repo, lockfileHash } = parsed.data;
  const digest = sha256Hex(`${repo}\n${lockfileHash}`).slice(0, HASH_LENGTH);
  const key = `dep-${platform}-${tool}-${digest}`;
  assertCacheKey(key);
  return key;
}

export interface WorkspaceRecord {
  workspaceKey: string;
  lastUsedAt: string;
}

/** M65 default: a workspace untouched for this long is deleted from disk. */
export const WORKSPACE_MAX_AGE_DAYS_DEFAULT = 60;

const DAY_MS = 86_400_000;

/**
 * M65: which workspaces are dormant enough to remove. Pure, so the lifecycle
 * rule is unit-testable without a clock or a disk; the caller archives
 * session+journal through StoragePort first, then deletes.
 */
export function expiredWorkspaces(
  records: readonly WorkspaceRecord[],
  now: Date,
  maxAgeDays: number = WORKSPACE_MAX_AGE_DAYS_DEFAULT,
): WorkspaceRecord[] {
  const days = z.number().int().positive().max(3_650).parse(maxAgeDays);
  const deadline = now.getTime() - days * DAY_MS;
  return records.filter((record) => {
    const lastUsed = Date.parse(record.lastUsedAt);
    // Fail-closed on an unreadable timestamp: never delete what we cannot date.
    return Number.isFinite(lastUsed) && lastUsed <= deadline;
  });
}
