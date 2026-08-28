import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContainerRunner } from "../src/index.js";

/**
 * TEST-ONLY container runner. The package itself never spawns a process — this
 * exists so the integration test can drive the SAME production code path
 * against real scanner images (`MAESTRO_SCANNERS_IT=1`). `@maestro/runners`
 * owns the production implementation.
 */
export interface DockerRunnerOptions {
  /** Extra `-v` arguments, e.g. a seeded trivy DB cache (see RAPOR.md §5). */
  mounts?: string[];
}

export function dockerRunner(options: DockerRunnerOptions = {}): ContainerRunner {
  return {
    async run(request) {
      const args = [
        "run", "--rm",
        "--network", request.network === "none" ? "none" : "bridge",
        "-v", `${request.workspacePath}:${request.workspaceMountPath}:ro`,
        ...(options.mounts ?? []).flatMap((mount) => ["-v", mount]),
        ...Object.entries(request.env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
        "--entrypoint", request.argv[0] ?? "sh",
        request.image,
        ...request.argv.slice(1),
      ];

      return await new Promise((resolve, reject) => {
        execFile(
          "docker", args,
          { timeout: request.timeoutSeconds * 1_000, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
          (error, stdout, stderr) => {
            const failure = error as (Error & { code?: number; killed?: boolean }) | null;
            if (failure && typeof failure.code !== "number" && !failure.killed) {
              reject(failure);
              return;
            }
            resolve({
              exitCode: failure?.code ?? 0,
              stdout,
              stderr,
              timedOut: failure?.killed === true,
            });
          },
        );
      });
    },
  };
}

/** A throw-away workspace outside the repository — planted secrets stay out of git. */
export function makeWorkspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "maestro-scan-it-"));
  write(root, files);
  return root;
}

/**
 * Two commits: a clean base and a dirty HEAD. This is what `diffBaseRef`
 * targets — the range scan is a different tool subcommand from the tree scan.
 */
export function makeGitWorkspace(base: Record<string, string>, head: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "maestro-scan-it-git-"));
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", root, "-c", "user.email=it@maestro.local", "-c", "user.name=maestro-it", ...args], {
      stdio: "ignore",
    });
  };
  git("init", "-q");
  write(root, base);
  git("add", "-A");
  git("commit", "-qm", "base");
  // A named ref, because `diffBaseRef` only accepts plain refs — `HEAD~1` and
  // anything else that could be read as a flag is refused by the driver.
  git("branch", "-f", "base-ref");
  write(root, head);
  git("add", "-A");
  git("commit", "-qm", "head");
  return root;
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
}
