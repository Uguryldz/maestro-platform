import { fileURLToPath } from "node:url";

/**
 * Paths to the deployment artefacts the tests read.
 *
 * Resolved from this module's own URL rather than from `process.cwd()`: the
 * suite must give the same answer whether it is run from the package, from the
 * repository root, or by turbo.
 */

/** `maestro/deploy/` — the non-code deployment artefacts. */
export function deployDir(): string {
  return fileURLToPath(new URL("../../../deploy/", import.meta.url));
}

export function composePath(): string {
  return `${deployDir()}compose.yaml`;
}

export function envExamplePath(): string {
  return `${deployDir()}.env.example`;
}

export function dockerfilePath(name: string): string {
  return `${deployDir()}docker/${name}`;
}

/**
 * `maestro/deploy/banka/` — the air-gapped bank bundle.
 *
 * A SEPARATE artefact from the files above, and the distinction matters: the
 * bundle is what leaves the building on a USB stick, it builds nothing, and it
 * is the only copy a bank's sysadmin ever sees. A defect fixed in
 * `deploy/compose.yaml` does not reach it.
 */
export function bankaDir(): string {
  return fileURLToPath(new URL("../../../deploy/banka/", import.meta.url));
}

export function bankaComposePath(): string {
  return `${bankaDir()}docker-compose.yml`;
}

export function bankaEnvExamplePath(): string {
  return `${bankaDir()}.env.example`;
}

export function bankaInstallPath(): string {
  return `${bankaDir()}install.sh`;
}

export function bankaReadmePath(): string {
  return `${bankaDir()}README.md`;
}

export function bankaResetAdminPath(): string {
  return `${bankaDir()}reset-admin.sh`;
}

export function bankaNginxConfPath(): string {
  return `${bankaDir()}studio-nginx.conf`;
}

/**
 * `maestro/deploy/ugurdocker/` — the registry-pull bundle.
 *
 * A THIRD artefact, and the difference from `banka/` is one line of operator
 * workflow: images are pulled from a registry the operator populates and
 * administers themselves, rather than carried in as tar files. Everything else
 * — the hardening, the healthchecks, the ordering — is deliberately identical,
 * which is exactly why it needs its own guards: a copy that shares no code with
 * its original drifts from it silently.
 */
export function ugurdockerDir(): string {
  return fileURLToPath(new URL("../../../deploy/ugurdocker/", import.meta.url));
}

export function ugurdockerComposePath(): string {
  return `${ugurdockerDir()}docker-compose.yml`;
}

export function ugurdockerEnvExamplePath(): string {
  return `${ugurdockerDir()}.env.example`;
}

export function ugurdockerInstallPath(): string {
  return `${ugurdockerDir()}install.sh`;
}

export function ugurdockerReadmePath(): string {
  return `${ugurdockerDir()}README.md`;
}

export function ugurdockerGitignorePath(): string {
  return `${ugurdockerDir()}.gitignore`;
}

export function ugurdockerResetAdminPath(): string {
  return `${ugurdockerDir()}reset-admin.sh`;
}

export function ugurdockerNginxConfPath(): string {
  return `${ugurdockerDir()}studio-nginx.conf`;
}

/**
 * `maestro/packages/db/prisma/migrations/` — the schema history itself.
 *
 * The installers pin a MINIMUM migration-directory count (`MIG_BEKLENEN`) so a
 * stale image cannot pass as current. That literal is hand-written in two shell
 * scripts no compiler reads, and it already went stale once: 0021 landed, the
 * scripts kept saying 21, and a pre-panel image sailed through the check. The
 * bundle tests compare the literal against this directory, so the count cannot
 * drift silently again.
 */
export function migrationsDir(): string {
  return fileURLToPath(new URL("../../../packages/db/prisma/migrations/", import.meta.url));
}

/**
 * `maestro/.dockerignore` — the repository root, not `deploy/`.
 *
 * It lives beside the build CONTEXT (the monorepo root is what both Dockerfiles
 * are built from), which is why it is not under `deployDir()` with its
 * neighbours.
 */
export function dockerignorePath(): string {
  return fileURLToPath(new URL("../../../.dockerignore", import.meta.url));
}
