import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The demo's stand-in for the hardened sandbox (M25/M60 — a real container
 * pool arrives in wave 2). It is deliberately small and honest: the generated
 * files are written to a throwaway temp directory and the generated test is
 * executed with the plain Node binary. Nothing is mounted, nothing is cached,
 * and the process inherits NO environment, so the OpenRouter key cannot leak
 * into it.
 */

/** Fixed paths, so the model's import specifier is predictable. */
export const IMPLEMENTATION_PATH = "src/impl.mjs";
export const TEST_PATH = "test/impl.test.mjs";

export interface DemoWorkspace {
  root: string;
  write(relativePath: string, content: string): Promise<void>;
  runTest(timeoutMs?: number): Promise<TestRun>;
  dispose(): Promise<void>;
}

export interface TestRun {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export async function createWorkspace(): Promise<DemoWorkspace> {
  const root = await mkdtemp(join(tmpdir(), "maestro-demo-"));
  return {
    root,
    async write(relativePath: string, content: string): Promise<void> {
      const full = join(root, relativePath);
      mkdirSync(dirname(full), { recursive: true });
      await writeFile(full, content, "utf8");
    },
    runTest(timeoutMs = 20_000): Promise<TestRun> {
      const startedAt = Date.now();
      return new Promise<TestRun>((resolve) => {
        execFile(
          process.execPath,
          [TEST_PATH],
          { cwd: root, timeout: timeoutMs, env: { PATH: process.env["PATH"] ?? "" } },
          (error, stdout, stderr) => {
            const code =
              error && typeof (error as { code?: unknown }).code === "number"
                ? ((error as { code: number }).code)
                : error
                  ? null
                  : 0;
            resolve({
              ok: error === null,
              exitCode: code,
              stdout: String(stdout).trim(),
              stderr: String(stderr).trim(),
              durationMs: Date.now() - startedAt,
            });
          },
        );
      });
    },
    async dispose(): Promise<void> {
      await rm(root, { recursive: true, force: true });
    },
  };
}
