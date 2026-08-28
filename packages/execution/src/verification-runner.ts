import { TruncatedOutputError } from "./errors.js";
import { runInSandbox, type SandboxSessionDeps } from "./sandbox-session.js";
import type { CommandResult, CommandSpec, VerificationRunner } from "./types.js";

/**
 * `VerificationRunner` over the runner fleet — the repo's OWN lint/build/test
 * commands (`.maestro.yaml`, M71), run in the sandbox.
 *
 * The commands come from the repository, not from this package: a bank's Java
 * service and a Node service verify themselves differently, and a platform
 * that hard-coded either would silently skip the other's checks.
 *
 * Two properties matter more than the plumbing:
 *
 *  · the EXIT CODE is the verdict. Nothing here reads the output to decide
 *    whether a build passed — `runTests` in the workflow makes the same point,
 *    and it is why a summariser that says "all green" over a red build cannot
 *    open a PR;
 *  · truncated output is NOT a pass. See `assertComplete`.
 */

export interface SandboxVerificationOptions extends SandboxSessionDeps {
  /** Cancels the running command — the kill switch's path into a build. */
  readonly signal?: AbortSignal;
  /**
   * The runner's stdout/stderr tail budget, in bytes.
   *
   * Must match the runner's own `maxLogBytes`. It is passed in rather than
   * imported because `@maestro/execution` does not depend on `@maestro/runners`
   * (the port is the seam), and a wrong value here fails SAFE: too small means
   * a complete report is occasionally re-run, too large means truncation goes
   * unnoticed — so the composition root passes the real one.
   */
  readonly tailLimitBytes: number;
  /**
   * What to do when output hit the tail budget. Default `"fail"`.
   *
   * `"fail"` marks the command failed and says why; the strike ladder then
   * treats it like any other red command and a human sees the reason. `"throw"`
   * raises `TruncatedOutputError` instead, for a caller that would rather stop
   * the turn than record a failure. Neither option lets it read as a pass.
   */
  readonly onTruncated?: "fail" | "throw";
}

/**
 * Exit code recorded for a command whose output was cut. Not one of the
 * command's own codes — it did not produce this, the platform did — and
 * distinct from 0 so every "did it pass" check in the tree treats it as red.
 */
export const TRUNCATED_EXIT_CODE = -2;

export class SandboxVerificationRunner implements VerificationRunner {
  constructor(private readonly options: SandboxVerificationOptions) {}

  async run(workspacePath: string, spec: CommandSpec): Promise<CommandResult> {
    const startedAt = Date.now();
    const result = await runInSandbox(
      this.options,
      // Run from the workspace root: a repo's `npm test` assumes its own cwd,
      // and the runner's default is the mount point rather than the clone.
      { command: ["sh", "-c", `cd "$0" && exec "$@"`, workspacePath, ...spec.command] },
      this.options.signal,
    );

    const truncated = this.truncationOf(spec, result.stdoutTail, result.stderrTail);
    if (truncated !== null) return truncated;

    return {
      name: spec.name,
      command: spec.command,
      exitCode: result.exitCode,
      stdoutTail: result.stdoutTail,
      stderrTail: result.stderrTail,
      durationMs: result.durationMs > 0 ? result.durationMs : Date.now() - startedAt,
    };
  }

  /**
   * The truncation check — the reason this class exists rather than a lambda.
   *
   * `RunnerPort` returns TAILS: when a command prints more than the budget,
   * `tail()` keeps the LAST N bytes and drops the head, with nothing in
   * `RunResult` to say it happened. For a test report that is not a smaller
   * report. The summary line a reader looks for ("Tests: 3 failed") is at the
   * end and survives; the failure detail it refers to is in the part that was
   * dropped. Worse, a green exit code with a cut report cannot be shown to
   * have come from the run it appears to describe.
   *
   * A report at exactly the budget is treated as cut. It may not be — but a
   * stream that ends on the byte the budget ends on is indistinguishable from
   * one that was trimmed to it, and the safe reading of "indistinguishable" on
   * a verification gate is the pessimistic one.
   */
  private truncationOf(spec: CommandSpec, stdout: string, stderr: string): CommandResult | null {
    const limit = this.options.tailLimitBytes;
    if (limit <= 0) return null;

    const stdoutBytes = Buffer.byteLength(stdout, "utf8");
    const stderrBytes = Buffer.byteLength(stderr, "utf8");
    if (stdoutBytes < limit && stderrBytes < limit) return null;

    if ((this.options.onTruncated ?? "fail") === "throw") {
      throw new TruncatedOutputError(spec.name, limit);
    }
    return {
      name: spec.name,
      command: spec.command,
      exitCode: TRUNCATED_EXIT_CODE,
      stdoutTail: stdout,
      // The reason goes in the STDERR tail, where every consumer already looks
      // for why a command failed — the CI fingerprint, the handover note and
      // the journal all read it without needing to know about this class.
      stderrTail:
        `${stderr}\n[maestro] output reached the ${limit}-byte tail budget and was truncated; ` +
        `this result cannot be read as a pass (see TruncatedOutputError)`,
      durationMs: 0,
    };
  }
}
