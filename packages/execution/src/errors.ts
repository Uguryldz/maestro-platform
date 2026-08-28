/** Base class so a composition root can catch everything this package throws. */
export class ExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionError";
  }
}

/** Misconfiguration of the runner itself (bad pattern, bad limit). */
export class ExecutionConfigError extends ExecutionError {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionConfigError";
  }
}

/**
 * A run's declared data class changed between two turns. Fail-closed and loud:
 * the journal writer holds ONE masking session per run, so a mid-run change
 * would either re-tokenise text the journal already recorded (turn 1's
 * `[IBAN_1.a3f9]` losing its brackets) or keep masking a now-stricter run with
 * the looser profile. Neither is recoverable after the fact.
 */
export class DataClassChangedError extends ExecutionError {
  constructor(runId: string, from: string, to: string) {
    super(`run ${runId} was journalled as data class "${from}" and this turn declares "${to}"`);
    this.name = "DataClassChangedError";
  }
}

/** The workspace could not be inspected, so "nothing was touched" is unprovable. */
export class WorkspaceProbeError extends ExecutionError {
  constructor(workspacePath: string, cause: string) {
    super(`workspace ${workspacePath} could not be inspected (${cause}); protected-path enforcement cannot be proven`);
    this.name = "WorkspaceProbeError";
  }
}

/**
 * The session was cancelled — the kill switch (M58), a lost lease, a shutdown.
 *
 * Distinct from every other error in this file because it is the one that must
 * NOT be retried and must not be recorded as a failed turn: nothing went wrong
 * with the code, the platform stopped the work. Callers that would otherwise
 * match on message text ask `isAbortError` instead.
 */
export class SandboxAbortedError extends ExecutionError {
  constructor(
    readonly runId: string,
    readonly reason: string,
  ) {
    super(`run ${runId}: sandbox session aborted (${reason})`);
    this.name = "SandboxAbortedError";
  }
}

/**
 * A verification command produced more output than the runner will carry back.
 *
 * `RunnerPort` returns stdout/stderr TAILS, and `tail()` drops the HEAD of the
 * stream to fit its byte budget. For a test report that is not a smaller
 * report: the summary line a parser looks for ("3 failing") sits at the end,
 * but the failure list it names sits in the part that was dropped — and a
 * runner whose output was cut has no way to prove it exited 0 for the reason
 * it appears to have. The same reasoning already keeps `unbridgedScanRunner`
 * refusing rather than parsing a truncated scanner report (M27).
 */
export class TruncatedOutputError extends ExecutionError {
  constructor(
    readonly commandName: string,
    readonly limitBytes: number,
  ) {
    super(
      `verification command "${commandName}" produced more output than the ${limitBytes}-byte tail ` +
        `the runner carries back; the result cannot be read as a pass`,
    );
    this.name = "TruncatedOutputError";
  }
}
