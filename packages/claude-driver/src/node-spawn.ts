import { spawn } from "node:child_process";
import type { SpawnFn, SpawnResult } from "./types.js";

/**
 * Kill the child AND anything it started. `claude` is a launcher: it runs
 * hooks, MCP stdio servers and sandboxed shells as its own children, and
 * `child.kill()` reaches none of them — a timed-out turn used to leave a
 * grandchild still writing into the workspace after the orchestrator had
 * already recorded the turn as killed. `detached: true` makes the child a
 * process-group leader so the negative pid reaches the whole group.
 */
function killTree(pid: number | undefined, fallback: () => void): void {
  if (pid === undefined) {
    fallback();
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Group already gone, or the platform refused it: the direct child is
    // still worth killing.
    fallback();
  }
}

/**
 * The one impure adapter here: `SpawnFn` over `node:child_process`. It is
 * generic (it knows nothing about `claude`) so the runner's tests inject a
 * double and stay offline, while production still has a real implementation
 * instead of an interface nobody fills. `shell` is never used — arguments go as
 * an array, so a task or a path can never be re-interpreted by a shell.
 */
export function nodeSpawn(): SpawnFn {
  return (spec) =>
    new Promise<SpawnResult>((resolve, reject) => {
      const child = spawn(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env: { ...spec.env },
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        detached: true,
      });

      let stdout = "";
      let stderr = "";
      let pending = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid, () => child.kill("SIGKILL"));
      }, spec.timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (!spec.onStdoutLine) return;
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) if (line.trim() !== "") spec.onStdoutLine(line);
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (spec.onStdoutLine && pending.trim() !== "") spec.onStdoutLine(pending);
        resolve({ exitCode: code ?? -1, stdout, stderr, timedOut });
      });

      // `child.on("error")` does NOT cover the stdin socket. A CLI that dies
      // before reading its prompt (bad token, missing config, OOM) closes the
      // pipe, and a prompt larger than the pipe buffer then raises EPIPE with
      // no listener — an uncaught exception that took the whole orchestrator
      // down and lost the turn record. The write failing is not interesting;
      // `close` reports the real outcome a moment later.
      child.stdin.on("error", () => {});
      child.stdin.end(spec.stdin);
    });
}
