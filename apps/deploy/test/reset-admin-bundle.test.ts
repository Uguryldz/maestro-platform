import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  bankaInstallPath,
  bankaReadmePath,
  bankaResetAdminPath,
  ugurdockerInstallPath,
  ugurdockerReadmePath,
  ugurdockerResetAdminPath,
} from "./paths.js";

/**
 * The operator password-reset script, checked as data in BOTH bundles.
 *
 * The story it replaces: a locked-out prod admin recovered by hand — bcrypt in
 * a REPL, the hash pasted into psql. These assertions pin the supported path
 * so it cannot quietly rot: the script must exist in both bundles, stay
 * byte-identical between them (they are deliberate twins), run the tested bin
 * inside the application image, and never print or persist a fixed password.
 */

const ugurdocker = readFileSync(ugurdockerResetAdminPath(), "utf8");
const banka = readFileSync(bankaResetAdminPath(), "utf8");

describe("reset-admin.sh: one script, two bundles", () => {
  it("ships in both bundles", () => {
    expect(existsSync(ugurdockerResetAdminPath())).toBe(true);
    expect(existsSync(bankaResetAdminPath())).toBe(true);
  });

  it("is byte-identical between the bundles — the twins may not drift", () => {
    // Unlike install.sh (whose one difference is pull-vs-load), the reset flow
    // has no bundle-specific step at all, so the strongest possible lock holds.
    expect(ugurdocker).toBe(banka);
  });

  it("is executable, the way the README's ./reset-admin.sh invocation needs", () => {
    for (const path of [ugurdockerResetAdminPath(), bankaResetAdminPath()]) {
      expect(() => accessSync(path, constants.X_OK), `${path} is not executable`).not.toThrow();
    }
  });
});

describe("reset-admin.sh: how it does the job", () => {
  it("runs the reset BIN inside the application image via the migrate service", () => {
    // The image carries the built node_modules (bcryptjs, the Prisma client),
    // so the server needs no node/pnpm of its own — and the hash is produced by
    // the SAME implementation the BFF verifies with.
    expect(ugurdocker).toContain("docker compose run --rm");
    expect(ugurdocker).toContain("MAESTRO_ENTRYPOINT=apps/deploy/dist/bin/reset-admin-password.js");
    expect(ugurdocker).toMatch(/migrate "\$KULLANICI"/);
  });

  it("targets that bin at a source file that actually exists and is the tested one", () => {
    const source = fileURLToPath(
      new URL("../src/bin/reset-admin-password.ts", import.meta.url),
    );
    expect(existsSync(source), `${source} does not exist`).toBe(true);
    // The bin delegates to the unit-tested module rather than hand-rolling SQL.
    expect(readFileSync(source, "utf8")).toContain('from "../reset-admin.js"');
  });

  it("fails loudly, in Turkish, and never guesses a container name", () => {
    expect(ugurdocker).toContain("set -euo pipefail");
    // The stack may be named anything (COMPOSE_PROJECT_NAME); a hard-coded
    // `maestro-…` name is the bug the installers already fixed once.
    const code = ugurdocker
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    expect(code).not.toMatch(/docker (inspect|exec)\s+maestro-/);
    // Refuses to run outside the install directory / without the stack up.
    expect(ugurdocker).toContain('[[ -f .env ]]');
    expect(ugurdocker).toMatch(/docker compose ps -q\s+postgres/);
  });

  it("carries no fixed password — the credential is generated per run, in the bin", () => {
    expect(ugurdocker).not.toContain("admin123");
    expect(ugurdocker).not.toMatch(/PAROLA=["'][^"']+["']/);
  });
});

describe("the bootstrap credential story stays honest in both bundles", () => {
  it("no installer or README promises the retired fixed password", () => {
    for (const path of [
      ugurdockerInstallPath(),
      bankaInstallPath(),
      ugurdockerReadmePath(),
      bankaReadmePath(),
    ]) {
      expect(readFileSync(path, "utf8"), `${path} still mentions admin123`).not.toContain(
        "admin123",
      );
    }
  });

  it("both READMEs point the locked-out operator at reset-admin.sh", () => {
    for (const path of [ugurdockerReadmePath(), bankaReadmePath()]) {
      expect(readFileSync(path, "utf8"), `${path} does not mention reset-admin.sh`).toContain(
        "reset-admin.sh",
      );
    }
  });

  it("both installers tell the operator to note the one-time password", () => {
    for (const path of [ugurdockerInstallPath(), bankaInstallPath()]) {
      const install = readFileSync(path, "utf8");
      expect(install, `${path} does not flag the one-time password`).toContain("GEÇİCİ PAROLA");
      expect(install, `${path} does not offer the reset path`).toContain("./reset-admin.sh");
    }
  });
});
