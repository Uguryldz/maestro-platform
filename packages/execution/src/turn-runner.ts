import type { PlatformProfile } from "@maestro/contracts";
import type { RunnerPort } from "@maestro/ports";
import { AgentExecution, type AgentExecutionDeps, type AgentTurnRequest, type AgentTurnResult } from "./execution.js";
import { PersistentStrikeLedger } from "./persistent-strikes.js";
import { SandboxVerificationRunner } from "./verification-runner.js";
import { SandboxWorkspaceProbe } from "./workspace-probe.js";

/**
 * `AgentTurnRunner`, assembled — the seam `unwiredAgentTurnRunner` refused to
 * fill.
 *
 * The three collaborators are built PER TURN rather than once, because two of
 * them are bound to things that are per-turn: the run's workspace volume, and
 * the `AbortSignal` that a `stop_all` fires. A probe built once at boot would
 * hold the first run's workspace key and the first run's (already-settled)
 * signal, so the kill switch would reach exactly one turn — the one nobody was
 * running.
 *
 * `AgentExecution` itself IS built once: it owns the per-run journal writers,
 * and with them the masking sessions whose ReverseMap holds the real values
 * behind every token. Rebuilding it per turn would mint a fresh token
 * vocabulary each time and break the M30 journal continuity that
 * `createReportJournal` documents at length.
 */

export interface TurnRunnerOptions {
  readonly runner: RunnerPort;
  readonly platform: PlatformProfile;
  readonly strikes: PersistentStrikeLedger;
  /** Everything `AgentExecution` needs except the three collaborators. */
  readonly execution: Omit<AgentExecutionDeps, "probe" | "verifier" | "strikes">;
  /** Must equal the runner's `maxLogBytes`; see `SandboxVerificationOptions`. */
  readonly tailLimitBytes: number;
  /** M23 budget for one verification command. */
  readonly commandTimeoutSeconds: number;
  /**
   * The kill switch's reach into a running turn (M58).
   *
   * Returns the signal for a run, or `undefined` when the platform has no
   * opinion. Called at the START of each turn so the switch state that matters
   * is the one in force when the work begins — and because the signal is
   * handed to `runSession`, a switch that fires MID-command tears the container
   * down rather than waiting for it to finish.
   */
  readonly signalFor?: (runId: string) => AbortSignal | undefined;
  /**
   * Maps a run to its workspace volume. Defaults to the run id, which is what
   * the provisioner uses when nothing else is configured.
   */
  readonly workspaceKeyFor?: (req: AgentTurnRequest) => string;
}

export class SandboxAgentTurnRunner {
  private readonly execution: AgentExecution;

  constructor(private readonly options: TurnRunnerOptions) {
    this.execution = new AgentExecution({
      ...options.execution,
      strikes: options.strikes,
      /**
       * The instance-level fallbacks, which this runner never uses: `runTurn`
       * passes a workspace-bound pair for every turn.
       *
       * They REFUSE rather than returning empty results. Reaching one would
       * mean a turn ran without its own probe, and "no files changed" is
       * exactly the answer that walks an illegal diff straight through the M52
       * gate — the failure has to be loud, not permissive.
       */
      probe: refusingProbe(),
      verifier: refusingVerifier(),
    });
  }

  /**
   * One turn, with the sandbox collaborators bound to THIS run.
   *
   * The abort is re-thrown rather than converted into a failed turn. A
   * cancelled turn is not a turn that went wrong: recording it as `failed`
   * would spend a strike on the platform's own decision and, at three, hand a
   * human a ticket whose "three failed attempts" were three kill-switch
   * presses.
   */
  async runTurn(req: AgentTurnRequest): Promise<AgentTurnResult> {
    const runId = req.context.runId;
    const signal = this.options.signalFor?.(runId);
    // Counters are read back BEFORE the turn — see `PersistentStrikeLedger`.
    // Without this the count restarts at zero after every redeploy and the
    // three-strike handover never fires.
    await this.options.strikes.hydrate(runId);

    const sandbox = {
      runner: this.options.runner,
      platform: this.options.platform,
      workspaceKey: this.options.workspaceKeyFor?.(req) ?? runId,
      runId,
      timeoutSeconds: this.options.commandTimeoutSeconds,
      ...(signal === undefined ? {} : { signal }),
    };

    try {
      return await this.execution.runTurn(req, {
        probe: new SandboxWorkspaceProbe(sandbox),
        verifier: new SandboxVerificationRunner({ ...sandbox, tailLimitBytes: this.options.tailLimitBytes }),
      });
    } finally {
      // The strike that justified a handover must be on disk before the
      // workflow acts on it — a worker shut down right here would otherwise
      // hand over on a count that no longer exists.
      await this.options.strikes.pendingWrites();
    }
  }

  endRun(runId: string): void {
    this.execution.endRun(runId);
    this.options.strikes.forget(runId);
  }

}

function refusingProbe(): AgentExecutionDeps["probe"] {
  const refuse = (): never => {
    throw new Error(
      "execution: the turn's workspace probe was not bound — a turn ran outside " +
        "SandboxAgentTurnRunner.runTurn, and an unbound probe cannot prove what the session changed (M52)",
    );
  };
  return { changedFiles: refuse, internalChangedFiles: refuse };
}

function refusingVerifier(): AgentExecutionDeps["verifier"] {
  return {
    run: (): never => {
      throw new Error(
        "execution: the turn's verification runner was not bound — a turn ran outside " +
          "SandboxAgentTurnRunner.runTurn, and an unbound verifier cannot prove the build is green",
      );
    },
  };
}
