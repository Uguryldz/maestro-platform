import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bankaComposePath,
  bankaEnvExamplePath,
  bankaInstallPath,
  ugurdockerComposePath,
  ugurdockerEnvExamplePath,
  ugurdockerInstallPath,
} from "./paths.js";

/**
 * What install.sh assumes about the published image, checked as data.
 *
 * The installer runs code INSIDE the image (`docker compose run ... bff`), so
 * every path it imports is a bet on what the Dockerfile actually shipped. The
 * image ships compiled `dist/` only — `src/` and tsx are pruned by
 * deploy/docker/Dockerfile.node's allow-list. The bet was lost once: the env
 * preflight imported `./src/env.ts` via tsx, and EVERY installation died at
 * §11b with ERR_MODULE_NOT_FOUND while the error text pointed operators at
 * their .env file.
 *
 * Same reasoning as the migration-count staleness lesson (see paths.ts,
 * `migrationsDir`): a literal written in a shell script no compiler reads goes
 * stale silently, so a test must read it back against the artefact it
 * describes.
 */

const bundles = [
  {
    name: "ugurdocker",
    install: readFileSync(ugurdockerInstallPath(), "utf8"),
    envExample: readFileSync(ugurdockerEnvExamplePath(), "utf8"),
    compose: readFileSync(ugurdockerComposePath(), "utf8"),
  },
  {
    name: "banka",
    install: readFileSync(bankaInstallPath(), "utf8"),
    envExample: readFileSync(bankaEnvExamplePath(), "utf8"),
    compose: readFileSync(bankaComposePath(), "utf8"),
  },
] as const;

describe.each(bundles)("$name install.sh: in-image code matches what the image ships", ({ install }) => {
  it("imports the compiled dist/env.js, never the pruned src/env.ts", () => {
    // The mention of `apps/deploy/src/env.ts` in COMMENTS is fine — that is
    // where the schema lives in the repo. What must never come back is the
    // import specifier executed inside the container.
    expect(install).not.toContain('from "./src/env.ts"');
    expect(install).toContain('from "./dist/env.js"');
  });

  it("runs the preflight with plain node — tsx is not in the production image", () => {
    expect(install).not.toMatch(/--import tsx/);
    expect(install).toMatch(/node --input-type=module/);
  });

  it("tells the operator about the missing-module case instead of blaming .env for it", () => {
    // The original error block only said "a variable is missing from .env",
    // which sent operators debugging the wrong file for a broken image.
    expect(install).toContain("ERR_MODULE_NOT_FOUND");
  });
});

describe.each(bundles)("$name bundle: BUNDLE_VERSION agrees across its three sources", ({ install, envExample, compose }) => {
  // install.sh greps `^BUNDLE_VERSION=` out of the operator's .env and compares
  // it to its own literal. That check silently never fired in one bundle:
  // .env.example carried the version only in a COMMENT, so the copied .env had
  // no assignment to grep — and the three files had already drifted apart
  // (2026-08-18 vs 2026-08-19) with nobody told.

  function assignment(text: string, label: string): string {
    const version = text.match(/^BUNDLE_VERSION="([^"]+)"$/m)?.[1];
    expect(version, `${label} has no real BUNDLE_VERSION= assignment`).toBeDefined();
    if (version === undefined) throw new Error(`${label}: unreachable, expect above throws first`);
    return version;
  }

  it(".env.example carries a real assignment, so the installer's version check can fire", () => {
    assignment(envExample, ".env.example");
  });

  it("install.sh, .env.example and docker-compose.yml name one and the same version", () => {
    const fromInstall = assignment(install, "install.sh");
    const fromEnv = assignment(envExample, ".env.example");
    const fromCompose = compose.match(/^# BUNDLE_VERSION: (\S+)$/m)?.[1];
    expect(fromCompose, "docker-compose.yml has no BUNDLE_VERSION header").toBeDefined();

    expect(fromEnv).toBe(fromInstall);
    expect(fromCompose).toBe(fromInstall);
  });
});

describe.each(bundles)("$name .env.example: no pre-filled Jira address", ({ envExample }) => {
  it("ships both Jira base URLs as commented examples only", () => {
    // A filled example (`JIRA_CLOUD_BASE_URL="https://kurum.atlassian.net"`)
    // meant an untouched .env sailed through install.sh with a made-up address
    // approved green — and a DC operator who forgot to comment the other line
    // hit the "both filled" refusal. The installer already warns by name when
    // neither is set, so an empty default is safe.
    expect(envExample).not.toMatch(/^JIRA_BASE_URL=/m);
    expect(envExample).not.toMatch(/^JIRA_CLOUD_BASE_URL=/m);
    // The commented examples must stay, or the operator has nothing to open.
    expect(envExample).toMatch(/^# JIRA(_CLOUD)?_BASE_URL=/m);
  });
});
