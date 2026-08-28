import { describe, expect, it } from "vitest";
import { ContainerScanConfig, ScanConfigError, parsePinnedImage } from "../src/index.js";
import { IMAGES } from "./helpers.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

describe("digest pinning (M27)", () => {
  it("accepts a plain digest reference", () => {
    const image = parsePinnedImage(`zricethezav/gitleaks@${DIGEST}`);

    expect(image.name).toBe("zricethezav/gitleaks");
    expect(image.digest).toBe(DIGEST);
  });

  it("accepts a private registry with a port and a nested path", () => {
    expect(parsePinnedImage(IMAGES.trivy).digest).toBe(`sha256:${"3".repeat(64)}`);
  });

  it("refuses a tag-only reference — the whole point of M27", () => {
    expect(() => parsePinnedImage("aquasec/trivy:0.53.0")).toThrow(/not digest-pinned/);
  });

  it("refuses :latest even when a digest is present", () => {
    expect(() => parsePinnedImage(`aquasec/trivy:latest@${DIGEST}`)).toThrow(/mutable tag/);
    expect(() => parsePinnedImage(`aquasec/trivy:main@${DIGEST}`)).toThrow(/mutable tag/);
  });

  it("refuses a moving tag whatever its case, and the release-channel names (B10)", () => {
    for (const tag of ["LATEST", "Latest", "MAIN", "prod", "PROD", "release", "Production", "HEAD"]) {
      expect(() => parsePinnedImage(`aquasec/trivy:${tag}@${DIGEST}`)).toThrow(/mutable tag/);
    }
  });

  it("refuses an image NAME that a container runtime would read as an option (B9)", () => {
    // These were accepted before: the digest is valid, so nothing looked at the
    // name — and a DB-held config could inject runtime flags (M71).
    const hostile = [
      "--privileged", "--entrypoint=sh", "-v/etc:/etc", "--network=host",
      "--user=0", "-", "tool;rm -rf /", "tool|cat", "tool$(id)", "TOOL", "tool/", "/tool",
    ];

    for (const name of hostile) {
      expect(() => parsePinnedImage(`${name}@${DIGEST}`)).toThrow(ScanConfigError);
    }
  });

  it("still accepts the reference shapes a bank registry actually produces", () => {
    const valid = [
      "trivy", "aquasec/trivy", "registry.bank.example:5000/security/trivy",
      "registry.bank.example/team_sec/sub.path/trivy", "ghcr.io/gitleaks/gitleaks:v8.30.1",
      "registry.bank.example:5000/security/semgrep:1.171.0",
    ];

    for (const name of valid) expect(parsePinnedImage(`${name}@${DIGEST}`).name).toBe(name);
  });

  it("keeps an immutable tag next to the digest", () => {
    expect(parsePinnedImage(`aquasec/trivy:0.53.0@${DIGEST}`).digest).toBe(DIGEST);
  });

  it("refuses digests that are not sha256:<64 hex>", () => {
    expect(() => parsePinnedImage("tool@sha256:abc")).toThrow(ScanConfigError);
    expect(() => parsePinnedImage(`tool@sha256:${"A".repeat(64)}`)).toThrow(/not sha256/);
    expect(() => parsePinnedImage(`tool@md5:${"a".repeat(32)}`)).toThrow(/not sha256/);
  });

  it("refuses empty, whitespaced and double-@ references", () => {
    expect(() => parsePinnedImage("   ")).toThrow(/empty/);
    expect(() => parsePinnedImage(`tool @${DIGEST}`)).toThrow(/whitespace/);
    expect(() => parsePinnedImage(`tool@other@${DIGEST}`)).toThrow(/more than one/);
    expect(() => parsePinnedImage(`@${DIGEST}`)).toThrow(/no repository name/);
  });

  it("is enforced by the config schema, not only by the helper", () => {
    const rejected = ContainerScanConfig.safeParse({ image: "aquasec/trivy:latest" });

    expect(rejected.success).toBe(false);
    expect(JSON.stringify(rejected.error?.issues)).toMatch(/digest-pinned/);
    expect(ContainerScanConfig.safeParse({ image: IMAGES.trivy }).success).toBe(true);
  });
});

describe("container configuration defaults", () => {
  it("mirrors the platform-wide scan.block_level default (M71)", () => {
    expect(ContainerScanConfig.parse({ image: IMAGES.trivy }).blockLevel).toBe("high");
  });

  it("keeps scanners offline and read-only by default", () => {
    const config = ContainerScanConfig.parse({ image: IMAGES.trivy });

    expect(config.networkMode).toBe("none");
    expect(config.workspaceMountPath).toBe("/workspace");
    expect(config.includeStderrInError).toBe(false);
    expect(config.secretSeverity).toBe("critical");
  });

  it("refuses a relative mount path and a hostile env key", () => {
    expect(ContainerScanConfig.safeParse({ image: IMAGES.trivy, workspaceMountPath: "ws" }).success).toBe(false);
    expect(ContainerScanConfig.safeParse({ image: IMAGES.trivy, env: { "bad-key": "x" } }).success).toBe(false);
  });

  it("refuses env vars that are the forbidden flags by another name (B8)", () => {
    const forbidden = [
      { TRIVY_SEVERITY: "NONE" }, { TRIVY_IGNORE_UNFIXED: "true" }, { TRIVY_EXIT_CODE: "0" },
      { TRIVY_SKIP_DIRS: "/workspace" }, { GITLEAKS_CONFIG: "/tmp/empty.toml" },
      { GITLEAKS_CONFIG_TOML: "[rules]" }, { SEMGREP_RULES: "p/none" }, { SEMGREP_BASELINE_COMMIT: "HEAD" },
    ];

    for (const env of forbidden) {
      expect(ContainerScanConfig.safeParse({ image: IMAGES.trivy, env }).success).toBe(false);
    }
  });

  it("still allows env vars that only say where to fetch from", () => {
    const allowed = { TRIVY_DB_REPOSITORY: "registry.bank.example:5000/trivy-db:2", HTTPS_PROXY: "http://proxy:3128" };

    expect(ContainerScanConfig.safeParse({ image: IMAGES.trivy, env: allowed }).success).toBe(true);
  });
});
