import type { RunJob, RunnerLease, RunnerPort, RunResult } from "@maestro/ports";
import type { PlatformProfile } from "@maestro/contracts";
import { JobAbortedError, LeaseLostError } from "./errors.js";
import type { KillSwitchState } from "./kill-switch.js";
import { createOutputMasker, jobSecrets, type OutputMasker } from "./masking.js";
import type { LeasedJob } from "./protocol.js";

/**
 * Runs ONE leased job inside a sandbox (tasks #4, #5, #6).
 *
 * Three invariants this file exists to hold:
 *
 *  · **The sandbox is always torn down.** `release` runs in a `finally`, on
 *    every path — success, failure, kill switch, shutdown, a throw from the
 *    masker. A leaked sandbox on a developer's Mac is a workspace with the
 *    bank's source in it that nobody is watching.
 *
 *  · **The kill switch is checked at every step boundary**, not once at the
 *    top. Acquire, run, and collect are separate checkpoints — AND the running
 *    session is aborted through an `AbortSignal`, because a checkpoint between
 *    awaits cannot reach a job that is already inside `runSession`. Without the
 *    signal `stop_all` merely relabelled a build it had let run to the end.
 *
 *  · **The lease is renewed FOR AS LONG AS the job runs**, not once before it.
 *    A lease is what makes a double-run impossible; verified once and never
 *    again, it stops being that the moment the job outlives it. A refused
 *    renewal aborts the session through the same signal.
 */

/** Named so a test can assert exactly which boundary stopped the job. */
export type JobStep = "acquire" | "run" | "collect";

export interface JobOutcome {
  outcome: "succeeded" | "failed" | "cancelled";
  exitCode?: number;
  durationMs: number;
  reasonKey?: string;
  /** The step that refused to continue, when the job was cancelled. */
  stoppedAt?: JobStep;
}

export interface LogSink {
  (chunk: { stream: "stdout" | "stderr"; text: string }): Promise<void>;
}

export interface JobRunnerDeps {
  runner: RunnerPort;
  killSwitch: KillSwitchState;
  /** Platform profile leases are acquired for. */
  platform: PlatformProfile;
  now: () => Date;
  /** Streams masked output. Failures here must not fail the job. */
  logSink: LogSink;
  /** The agent's own token, so it can never appear in streamed output. */
  agentToken: string;
  /** Verifies the lease is still ours, renewing it when it nears expiry. */
  checkLease?: (leaseId: string) => Promise<void>;
  /**
   * How often `checkLease` is re-run WHILE the session is in flight. The
   * renewal margin is the natural bound: polling at the margin means the lease
   * is always re-asserted before it could lapse. `0` disables the loop, which
   * only the unit tests that drive `checkLease` by hand use.
   */
  leaseRenewIntervalMs?: number;
  /** Injected so the renewal loop is testable without real time passing. */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

/** Whatever the injected timer returns; the agent passes Node's. */
export type TimerHandle = ReturnType<typeof setInterval>;

/** Turns the wire job into the `RunJob` the runner port takes. */
export function toRunJob(job: LeasedJob): RunJob {
  return {
    runId: job.runId,
    workspaceKey: job.workspaceKey,
    command: [...job.command],
    timeoutSeconds: job.timeoutSeconds,
    env: { ...job.env },
  };
}

export class JobRunner {
  readonly #deps: JobRunnerDeps;

  constructor(deps: JobRunnerDeps) {
    this.#deps = deps;
  }

  /**
   * Executes the job. Never throws for an ordinary failure — the caller has to
   * report an outcome for every leased job, and an exception on this path
   * would leave the lease dangling until it expired.
   */
  async run(job: LeasedJob): Promise<JobOutcome> {
    const startedAt = this.#deps.now().getTime();
    const masker = createOutputMasker({ secrets: jobSecrets(this.#deps.agentToken, job.env) });

    // One controller per job. The kill switch, a refused renewal and shutdown
    // all abort through it, and `runSession` is contractually required to tear
    // the session down and reject when it fires — that is what turns "reported
    // cancelled" into "actually stopped".
    const control = new AbortController();
    let aborted: string | undefined;
    const abort = (reason: string): void => {
      aborted ??= reason;
      if (!control.signal.aborted) control.abort(new JobAbortedError(reason));
    };
    const untrack = this.#deps.killSwitch.track({ abort });

    const elapsed = (): number => this.#deps.now().getTime() - startedAt;
    const cancelled = (step: JobStep, reasonKey: string): JobOutcome => ({
      outcome: "cancelled",
      durationMs: elapsed(),
      reasonKey,
      stoppedAt: step,
    });

    try {
      // ── checkpoint 1: before anything is acquired ──────────────────────
      if (aborted !== undefined || !this.#deps.killSwitch.mayContinueRunning()) {
        return cancelled("acquire", "runner_agent.cancelled_kill_switch");
      }

      let lease: RunnerLease;
      try {
        lease = await this.#deps.runner.acquire(this.#deps.platform);
      } catch {
        // No capacity, or the driver refused the platform. Reported as a
        // failed job rather than thrown: the lease still needs an answer.
        return {
          outcome: "failed",
          durationMs: elapsed(),
          reasonKey: "runner_agent.sandbox_acquire_failed",
        };
      }

      try {
        // ── checkpoint 2: sandbox is held, work has not started ─────────
        if (aborted !== undefined || !this.#deps.killSwitch.mayContinueRunning()) {
          return cancelled("run", "runner_agent.cancelled_kill_switch");
        }
        // The lease is re-verified here, at the last moment before the
        // expensive step: if the platform already reassigned it, running now
        // would be a double execution of the same ticket.
        if (this.#deps.checkLease !== undefined) {
          try {
            await this.#deps.checkLease(job.leaseId);
          } catch (error) {
            if (error instanceof LeaseLostError) {
              return cancelled("run", "runner_agent.cancelled_lease_lost");
            }
            throw error;
          }
          // Re-checked AFTER the await: the renewal reply carries the
          // kill-switch level, so the switch can go down during this very
          // call. Checking only before it would start a job the platform had
          // already told this agent to stop.
          if (aborted !== undefined || !this.#deps.killSwitch.mayContinueRunning()) {
            return cancelled("run", "runner_agent.cancelled_kill_switch");
          }
        }

        // The lease is re-asserted for as long as the session runs. A refused
        // renewal aborts the signal, so the sandbox goes down instead of
        // finishing work another agent has already been given.
        const renewals = this.#startRenewals(job.leaseId, abort);
        let result: RunResult;
        try {
          result = await this.#deps.runner.runSession(lease, toRunJob(job), control.signal);
        } catch (error) {
          // An abort is a cancellation, not a failure: the reason says which of
          // the two hands pulled the cord.
          if (aborted !== undefined) return cancelled("run", this.#reasonFor(aborted));
          throw error;
        } finally {
          renewals();
        }

        // ── checkpoint 3: output collected, before it is reported ───────
        await this.#stream(masker, result);
        if (aborted !== undefined || !this.#deps.killSwitch.mayContinueRunning()) {
          return cancelled("collect", this.#reasonFor(aborted ?? "kill_switch_stop_all"));
        }
        return {
          outcome: result.exitCode === 0 ? "succeeded" : "failed",
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        };
      } finally {
        // Guaranteed teardown. A failure to release must not mask the real
        // outcome, but it must not be silent either.
        await this.#deps.runner.release(lease).catch(() => undefined);
      }
    } catch (error) {
      // The error's TEXT is never streamed: it can quote a command line, and a
      // command line can carry a credential.
      await this.#safeLog({
        stream: "stderr",
        text: masker.mask(error instanceof Error ? error.name : "job failed"),
      });
      return { outcome: "failed", durationMs: elapsed(), reasonKey: "runner_agent.job_failed" };
    } finally {
      untrack();
    }
  }

  /**
   * Re-asserts the lease on a timer while the session runs, returning the
   * canceller. A refused renewal (`LeaseLostError`) aborts the job; a renewal
   * that could not be DELIVERED does not, because an unreachable platform is
   * not a reassignment and the deadline still expires on its own.
   */
  #startRenewals(leaseId: string, abort: (reason: string) => void): () => void {
    const intervalMs = this.#deps.leaseRenewIntervalMs ?? 0;
    const check = this.#deps.checkLease;
    if (intervalMs <= 0 || check === undefined) return () => undefined;

    const setTimer = this.#deps.setTimer ?? ((fn, ms) => setInterval(fn, ms));
    const clearTimer = this.#deps.clearTimer ?? ((handle) => clearInterval(handle));

    let stopped = false;
    const handle = setTimer(() => {
      if (stopped) return;
      void check(leaseId).catch((error: unknown) => {
        if (stopped) return;
        // Only a LOST lease stops the job. Anything else is a transport
        // problem, and killing a good build over one would be its own outage.
        if (error instanceof LeaseLostError) abort("lease_lost");
      });
    }, intervalMs);
    handle.unref?.();

    return () => {
      stopped = true;
      clearTimer(handle);
    };
  }

  /** Maps an abort reason to the operator-facing catalogue key. */
  #reasonFor(reason: string): string {
    return reason === "lease_lost" ? "runner_agent.cancelled_lease_lost" : "runner_agent.cancelled_kill_switch";
  }

  /** Streams the collected tails, masked. */
  async #stream(masker: OutputMasker, result: RunResult): Promise<void> {
    if (result.stdoutTail.length > 0) {
      await this.#safeLog({ stream: "stdout", text: masker.mask(result.stdoutTail) });
    }
    if (result.stderrTail.length > 0) {
      await this.#safeLog({ stream: "stderr", text: masker.mask(result.stderrTail) });
    }
  }

  /** A log-stream failure must never turn a finished job into a failed one. */
  async #safeLog(chunk: { stream: "stdout" | "stderr"; text: string }): Promise<void> {
    await this.#deps.logSink(chunk).catch(() => undefined);
  }
}
