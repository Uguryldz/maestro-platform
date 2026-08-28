import type { PlatformProfile } from "@maestro/contracts";
import type { RunnerLease, RunnerPort, RunResult } from "@maestro/ports";
import { SandboxAbortedError } from "./errors.js";

/**
 * The one way this package runs anything inside a sandbox.
 *
 * Both collaborators that need a runner (`SandboxWorkspaceProbe` and
 * `SandboxVerificationRunner`) go through here rather than calling
 * `RunnerPort` themselves, because three of the rules below are easy to write
 * once and easy to forget twice:
 *
 *  1. the lease is released on EVERY path — success, failure, abort, timeout,
 *     and the throw that happens between `acquire` and `runSession`;
 *  2. the caller's `AbortSignal` is handed to `runSession` rather than being
 *     checked around it. Checking between awaits is what made `stop_all` a
 *     label on a build that had already finished (see `RunnerPort.runSession`);
 *  3. an abort REJECTS. A `RunResult` returned after the switch went down is
 *     indistinguishable from one the caller was still allowed to act on.
 */

export interface SandboxSessionDeps {
  readonly runner: RunnerPort;
  readonly platform: PlatformProfile;
  /** Volume the run's clone lives in; `RunJob.workspaceKey`. */
  readonly workspaceKey: string;
  readonly runId: string;
  /** M23 budget for one command. The runner also enforces its own ceiling. */
  readonly timeoutSeconds: number;
  readonly env?: Record<string, string>;
}

export interface SandboxCommand {
  readonly command: readonly string[];
  /** Overrides the deps-level budget for this one command. */
  readonly timeoutSeconds?: number;
}

/**
 * Acquire → run → release, with the lease released in `finally`.
 *
 * A lease is taken per command rather than per turn. It costs an acquire on a
 * pool that is already local, and it means a command that hangs long enough to
 * lose its lease cannot keep writing a workspace that has been handed to its
 * replacement — the second concrete failure named in the port's contract.
 */
export async function runInSandbox(
  deps: SandboxSessionDeps,
  cmd: SandboxCommand,
  signal?: AbortSignal,
): Promise<RunResult> {
  // Refused before a lease is taken when the caller has already given up: an
  // acquire here would occupy a pool slot for a job that must not start.
  throwIfAborted(signal, deps.runId);

  const lease: RunnerLease = await deps.runner.acquire(deps.platform);
  try {
    return await deps.runner.runSession(
      lease,
      {
        runId: deps.runId,
        workspaceKey: deps.workspaceKey,
        command: [...cmd.command],
        timeoutSeconds: cmd.timeoutSeconds ?? deps.timeoutSeconds,
        ...(deps.env === undefined ? {} : { env: deps.env }),
      },
      signal,
    );
  } finally {
    /**
     * Release cannot be allowed to replace the reason the session ended.
     *
     * When `runSession` rejects because the kill switch fired, that rejection
     * is the fact the caller has to see; a release that also fails would
     * otherwise overwrite it with a pool error and the run would be recorded
     * as a broken runner rather than a cancelled job.
     */
    await deps.runner.release(lease).catch(() => undefined);
  }
}

/**
 * The abort check, as an error this package owns.
 *
 * `signal.throwIfAborted()` throws the signal's own reason, which is whatever
 * the caller happened to pass to `abort()` — sometimes a string, sometimes an
 * `Error`. Normalising it here is what lets `AgentTurnRunner`'s callers tell a
 * cancellation apart from a genuine failure without matching on message text.
 */
export function throwIfAborted(signal: AbortSignal | undefined, runId: string): void {
  if (signal?.aborted !== true) return;
  throw new SandboxAbortedError(runId, describeReason(signal.reason));
}

export function describeReason(reason: unknown): string {
  if (reason === undefined || reason === null) return "aborted";
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

/**
 * True when a thrown value is an abort rather than a failure.
 *
 * The runner rejects with the signal's reason, so an abort arrives here as
 * whatever the kill switch passed — including a plain `DOMException` from
 * `AbortController.abort()`. Every caller that has to keep "cancelled" and
 * "failed" apart asks this rather than inspecting messages.
 */
export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true;
  if (error instanceof SandboxAbortedError) return true;
  return error instanceof DOMException && error.name === "AbortError";
}
