import { describe, expect, it } from "vitest";
import { RunnerKeyError } from "../src/errors.js";
import {
  assertCacheKey,
  assertWorkspaceKey,
  CACHE_MOUNT_ROOT,
  cacheMountPath,
  cacheVolumeName,
  dependencyCacheKey,
  expiredWorkspaces,
  WORKSPACE_MOUNT_PATH,
  workspaceVolumeName,
} from "../src/workspace.js";

const DOCKER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

describe("workspace key grammar", () => {
  it("accepts the shapes the workflow produces", () => {
    for (const key of ["UGURPAY-1042", "UGURPAY-1042/feature-x", "app.core/UGURPAY-7"]) {
      expect(() => assertWorkspaceKey(key)).not.toThrow();
    }
  });

  it("refuses anything that could walk out of a path or a flag", () => {
    for (const key of ["", "../etc/shadow", "a/../b", "a//b", "trailing/", "/leading", "-flag", "a b", "a;b", "a\\b"]) {
      expect(() => assertWorkspaceKey(key)).toThrow(RunnerKeyError);
    }
  });

  it("refuses an absurdly long key", () => {
    expect(() => assertWorkspaceKey("A".repeat(201))).toThrow(/longer than 200/);
  });
});

describe("volume naming", () => {
  it("is pure: the same key always produces the same name", () => {
    expect(workspaceVolumeName("UGURPAY-1042")).toBe(workspaceVolumeName("UGURPAY-1042"));
  });

  it("is injective: keys that slugify identically still get different names", () => {
    const a = workspaceVolumeName("UGURPAY-1042/feature-x");
    const b = workspaceVolumeName("UGURPAY-1042-feature-x");

    expect(a).not.toBe(b);
    expect(a.startsWith("maestro-ws-ugurpay-1042-feature-x-")).toBe(true);
  });

  /**
   * The ticket id is case-insensitive (Jira upper-cases it), so "UGURPAY-1042"
   * and "ugurpay-1042" are the SAME ticket and must resume into the same
   * workspace (M30) — while the branch part stays case-sensitive, because git
   * lets `feature/Foo` and `feature/foo` both exist and sharing one workspace
   * between them would mix two working trees.
   */
  it("folds the ticket segment's case but not the branch's", () => {
    expect(workspaceVolumeName("ugurpay-1042")).toBe(workspaceVolumeName("UGURPAY-1042"));
    expect(workspaceVolumeName("UgurPay-1042/feature/Foo")).toBe(workspaceVolumeName("UGURPAY-1042/feature/Foo"));
    expect(workspaceVolumeName("UGURPAY-1042/feature/Foo")).not.toBe(workspaceVolumeName("UGURPAY-1042/feature/foo"));
    expect(workspaceVolumeName("UGURPAY-1042")).not.toBe(workspaceVolumeName("UGURPAY-1043"));
  });

  it("always produces a valid docker object name", () => {
    for (const key of ["UGURPAY-1042", "a".repeat(199), "X0", "app.core/T-1"]) {
      expect(workspaceVolumeName(key)).toMatch(DOCKER_NAME);
      expect(workspaceVolumeName(key).length).toBeLessThan(64);
    }
  });

  it("honours the configured prefixes", () => {
    expect(workspaceVolumeName("T-1", "bank-ws").startsWith("bank-ws-")).toBe(true);
    expect(cacheVolumeName("dep-x", "bank-cache").startsWith("bank-cache-")).toBe(true);
  });

  it("validates the key before naming anything", () => {
    expect(() => workspaceVolumeName("../escape")).toThrow(RunnerKeyError);
    expect(() => cacheVolumeName("UPPER")).toThrow(RunnerKeyError);
  });
});

describe("cache keys and mount paths (M31 layer ①)", () => {
  it("derives a key from repo + lockfile, not from the ticket", () => {
    const first = dependencyCacheKey({
      platform: "linux-node",
      tool: "npm",
      repo: "UGURPAY/payments-api",
      lockfileHash: "a".repeat(40),
    });
    const second = dependencyCacheKey({
      platform: "linux-node",
      tool: "npm",
      repo: "UGURPAY/payments-api",
      lockfileHash: "a".repeat(40),
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^dep-linux-node-npm-[0-9a-f]{12}$/);
  });

  it("changes the moment the lockfile changes — a stale set is never reused", () => {
    const base = { platform: "linux-node", tool: "npm", repo: "UGURPAY/payments-api" } as const;

    expect(dependencyCacheKey({ ...base, lockfileHash: "a".repeat(40) })).not.toBe(
      dependencyCacheKey({ ...base, lockfileHash: "b".repeat(40) }),
    );
  });

  it("separates platforms and toolchains sharing one repo", () => {
    const base = { repo: "UGURPAY/mobile", lockfileHash: "c".repeat(64) } as const;

    expect(dependencyCacheKey({ ...base, platform: "linux-node", tool: "npm" })).not.toBe(
      dependencyCacheKey({ ...base, platform: "linux-android", tool: "gradle" }),
    );
  });

  it("refuses malformed inputs instead of hashing garbage", () => {
    expect(() => dependencyCacheKey({ platform: "linux-node", tool: "NPM", repo: "r", lockfileHash: "a".repeat(40) })).toThrow(
      RunnerKeyError,
    );
    expect(() => dependencyCacheKey({ platform: "linux-node", tool: "npm", repo: "r", lockfileHash: "zz" })).toThrow(
      RunnerKeyError,
    );
  });

  it("mounts each cache under one fixed root", () => {
    expect(cacheMountPath("dep-linux-node-npm-abc123abc123")).toBe(`${CACHE_MOUNT_ROOT}/dep-linux-node-npm-abc123abc123`);
    expect(WORKSPACE_MOUNT_PATH).toBe("/workspace");
  });

  it("refuses a cache key with a traversal or a slash", () => {
    expect(() => assertCacheKey("../x")).toThrow(RunnerKeyError);
    expect(() => assertCacheKey("a/b")).toThrow(RunnerKeyError);
    expect(() => cacheMountPath("..")).toThrow(RunnerKeyError);
  });
});

describe("workspace lifecycle (M65)", () => {
  const now = new Date("2026-08-08T14:20:00.000Z");
  const daysAgo = (days: number): string => new Date(now.getTime() - days * 86_400_000).toISOString();

  it("selects only workspaces dormant past the age limit", () => {
    const expired = expiredWorkspaces(
      [
        { workspaceKey: "T-1", lastUsedAt: daysAgo(61) },
        { workspaceKey: "T-2", lastUsedAt: daysAgo(59) },
        { workspaceKey: "T-3", lastUsedAt: daysAgo(60) },
      ],
      now,
    );

    expect(expired.map((record) => record.workspaceKey)).toEqual(["T-1", "T-3"]);
  });

  it("honours a shorter configured limit", () => {
    const records = [{ workspaceKey: "T-1", lastUsedAt: daysAgo(8) }];

    expect(expiredWorkspaces(records, now, 7)).toHaveLength(1);
    expect(expiredWorkspaces(records, now, 30)).toHaveLength(0);
  });

  it("never deletes a workspace whose timestamp cannot be read (fail-closed)", () => {
    expect(expiredWorkspaces([{ workspaceKey: "T-1", lastUsedAt: "not-a-date" }], now)).toEqual([]);
  });

  it("refuses a nonsensical age limit rather than deleting everything", () => {
    expect(() => expiredWorkspaces([], now, 0)).toThrow();
    expect(() => expiredWorkspaces([], now, -1)).toThrow();
  });
});
