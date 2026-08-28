import { describe, expect, it } from "vitest";
import {
  createProtectedPathMatcher,
  createUnreadablePathMatcher,
  DEFAULT_PROTECTED_PATHS,
  DEFAULT_UNREADABLE_PATHS,
} from "../src/protected-paths.js";

// B3 — the execution-surface half of the list was ROOT-ANCHORED while the
// secrets half was written with `**/`. In a monorepo (or any repo with a
// submodule, which is the rule in this bank, not the exception) that left
// `sub/.git/hooks/post-checkout` writable: the agent plants a hook, the runner
// runs any git operation in that sub-repo, and code executes on the build
// machine BEFORE the human gate and without a merge. That is the exact event
// M52 exists to prevent, so the runner surface is now `**/`-anchored too.
describe("createProtectedPathMatcher — the execution surface is not only at the repo root (B3)", () => {
  const matcher = createProtectedPathMatcher();
  const nested = [
    "sub/.git/config",
    "sub/.git/hooks/post-checkout",
    "packages/api/.git/hooks/pre-commit",
    "sub/.github/workflows/ci.yml",
    "vendor/lib/.github/workflows/release.yml",
    "sub/Jenkinsfile",
    "services/pay/Jenkinsfile",
    "sub/.gitlab-ci.yml",
    "sub/.maestro.yaml",
  ];
  for (const path of nested) {
    it(`catches nested ${path}`, () => {
      expect(matcher.match(path)).not.toBeNull();
    });
  }

  // `.maestro.yml` — the other legal YAML spelling. The loader may only read
  // `.maestro.yaml`, but a deny-list that protects one spelling and not the
  // other tells an attacker which filename to use.
  it("catches both YAML spellings of the repo policy file, at any depth", () => {
    for (const path of [".maestro.yaml", ".maestro.yml", "sub/.maestro.yaml", "sub/.maestro.yml"]) {
      expect(matcher.match(path), path).not.toBeNull();
    }
  });
});

// B6 — the deny-list is now two lists. Content that IS the secret is denied on
// both legs; everything else stays readable, because reading a migration or a
// pipeline is how an agent understands the system it is changing.
describe("the read-deny list is a strict subset of the write-deny list (B6)", () => {
  const unreadable = createUnreadablePathMatcher();
  const protectedPaths = createProtectedPathMatcher();

  const secrets = [
    "api/.env",
    ".env.production",
    "tls/server.key",
    "certs/chain.pem",
    "keys/store.p12",
    "keys/store.pfx",
    "keys/store.jks",
    "home/.ssh/id_rsa",
    "home/.ssh/id_ed25519",
    "config/secrets/db.json",
    ".npmrc",
    "sub/.netrc",
    "home/.pgpass",
  ];
  for (const path of secrets) {
    it(`refuses to hand back ${path}`, () => {
      expect(unreadable.match(path)).not.toBeNull();
    });
  }

  it("still lets the agent read what it must understand to do the work", () => {
    for (const path of [
      "db/migrations/0001_init.sql",
      ".github/workflows/ci.yml",
      "azure-pipelines.yml",
      ".maestro.yaml",
      "src/odeme/tutar.ts",
    ]) {
      expect(unreadable.match(path), path).toBeNull();
    }
  });

  it("keeps every unreadable path write-protected too — a subset, never a swap", () => {
    for (const path of secrets) {
      expect(protectedPaths.match(path), path).not.toBeNull();
    }
    for (const pattern of DEFAULT_UNREADABLE_PATHS) {
      expect(DEFAULT_PROTECTED_PATHS, pattern).toContain(pattern);
    }
  });
});

// B4 — the list named Jenkins and GitLab and did not name Azure DevOps, which
// is the CI this platform actually targets (M12: the PR and its policies live
// in ADO). A pipeline definition is executable configuration: whoever writes
// `azure-pipelines.yml` writes what the build agent runs.
describe("createProtectedPathMatcher — every CI and hook surface we actually run (B4)", () => {
  const matcher = createProtectedPathMatcher();
  const surfaces = [
    "azure-pipelines.yml",
    "azure-pipelines.yaml",
    "azure-pipelines-release.yml",
    "sub/azure-pipelines.yml",
    ".azuredevops/pull_request_template.md",
    "sub/.azuredevops/policies.yml",
    ".husky/pre-commit",
    "sub/.husky/post-checkout",
    ".vscode/tasks.json",
    "sub/.vscode/settings.json",
  ];
  for (const path of surfaces) {
    it(`protects ${path}`, () => {
      expect(matcher.match(path)).not.toBeNull();
    });
  }

  // The agent's actual job. M53 draws the dependency line at the human gate,
  // and a build file the agent may not touch is an agent that cannot work.
  it("still leaves the agent's own working surface writable", () => {
    for (const path of ["package.json", "sub/package.json", "Dockerfile", "svc/Dockerfile", "tsconfig.json"]) {
      expect(matcher.match(path), path).toBeNull();
    }
  });
});
