import type { PlatformProfile } from "@maestro/contracts";
import type { SessionReport } from "@maestro/execution";
import { PersistentStrikeLedger, SandboxAgentTurnRunner } from "@maestro/execution";
import type { LoadedPiiPolicy, OutboundCall } from "@maestro/pii";
import type { LlmPort, RunnerPort, StoragePort } from "@maestro/ports";
import type { CoreDeps } from "@maestro/workflows";
import { PrismaStrikeStore, type StrikeCounterDelegate } from "./strikes.js";

/**
 * The doing-role turn runner, wired.
 *
 * This file used to hold `unwiredAgentTurnRunner`, which refused by name: the
 * three collaborators `AgentExecution` needs — a `WorkspaceProbe`, a
 * `VerificationRunner` and a `StrikeLedger` — had no implementation, and an
 * adapter that pretended would have been worse than a refusal. All three now
 * exist in `@maestro/execution`:
 *
 *   WorkspaceProbe     → SandboxWorkspaceProbe    (git status + the .git/ scan)
 *   VerificationRunner → SandboxVerificationRunner (the repo's own commands)
 *   StrikeLedger       → PersistentStrikeLedger    (this file's Postgres store)
 *
 * so the seam is filled rather than declared missing, and the engineering turn
 * is no longer in `DEGRADED_CAPABILITIES`.
 */

/**
 * A turn runner that refuses — for a process that has the CODE but not a
 * sandbox fleet to run it in.
 *
 * This is not the old `unwiredAgentTurnRunner`, and the difference is the
 * point. That one said "nobody implemented the three collaborators", which no
 * operator could act on. All three exist now, so the only thing left that can
 * stop a turn is configuration, and this names it: set a digest-pinned image
 * and the turn runs.
 *
 * It also stands in during boot, between `buildWorkerCore` and the moment the
 * ports exist — see `bin/worker.ts`. Refusing there rather than composing a
 * half-built runner keeps a wiring mistake a loud error instead of a null
 * dereference at the first engineering turn.
 */
export function unrunnableTurnRunner(reason?: string): CoreDeps["execution"] {
  const message =
    reason ??
    "execution: the turn runner was used before the ports were built — this is a wiring " +
      "mistake in the worker's boot sequence, not a missing capability";
  return {
    runTurn: () => Promise.reject(new Error(message)),
    /**
     * A no-op rather than a throw. `endRun` is cleanup — the workflow calls it
     * on the way out of a run, including one that failed BECAUSE `runTurn`
     * refused. Throwing here would replace that failure's message with this
     * one and hide why the run actually stopped.
     */
    endRun: () => undefined,
  };
}

export interface TurnRunnerDeps {
  readonly runner: RunnerPort;
  readonly llm: LlmPort;
  readonly storage: StoragePort;
  readonly piiPolicy: LoadedPiiPolicy;
  readonly counters: StrikeCounterDelegate;
  /** Which fleet the turn's sandboxes come from. */
  readonly platform: PlatformProfile;
  /**
   * The runner's stdout/stderr tail budget, in BYTES, and it must be the
   * runner's real one.
   *
   * A verification result whose output filled the tail is treated as a
   * failure, because `tail()` drops the HEAD of the stream and a cut test
   * report cannot be shown to have come from the run it appears to describe.
   * Too small a value here re-runs the occasional complete report; too large a
   * value lets a truncated one read as a pass — so the caller passes the
   * configured number rather than a guess.
   */
  readonly tailLimitBytes: number;
  readonly commandTimeoutSeconds: number;
  /** The kill switch's reach into a running turn (M58). */
  readonly signalFor?: (runId: string) => AbortSignal | undefined;
  /** Where a write-behind strike failure is reported. */
  readonly onStrikeWriteError?: (error: unknown) => void;
  readonly now?: () => Date;
}

export function buildAgentTurnRunner(deps: TurnRunnerDeps): CoreDeps["execution"] {
  const now = deps.now ?? ((): Date => new Date());

  return new SandboxAgentTurnRunner({
    runner: deps.runner,
    platform: deps.platform,
    tailLimitBytes: deps.tailLimitBytes,
    commandTimeoutSeconds: deps.commandTimeoutSeconds,
    ...(deps.signalFor === undefined ? {} : { signalFor: deps.signalFor }),
    strikes: new PersistentStrikeLedger({
      store: new PrismaStrikeStore(deps.counters),
      now,
      /**
       * A failed write is NOT thrown at the turn: it already failed for its
       * own reason, and replacing that with a database error would tell the
       * operator the wrong story. It must not be silent either — a ledger that
       * quietly stopped persisting is a stuck-loop detector that has stopped
       * detecting.
       */
      onWriteError:
        deps.onStrikeWriteError ??
        ((error: unknown): void => {
          console.error("[maestro] strike counter write failed (M54 handover may be delayed)", error);
        }),
    }),
    execution: {
      llm: deps.llm,
      piiPolicy: deps.piiPolicy,
      journalSink: sessionReportSink(deps.storage),
      now,
    },
  });
}

/**
 * Where a masked session report is stored (M30).
 *
 * The parameter is `Masked<SessionReport>`, so a caller holding a raw report
 * simply cannot reach this — the boundary in `createReportJournal` has already
 * run `assertNoPii` over it, and `guardEgress` re-checks immediately before
 * this call. Both halves matter: the type stops this package writing a raw
 * report, the guard stops a masker that let something through.
 */
function sessionReportSink(storage: StoragePort): OutboundCall<SessionReport, void> {
  return async (masked) => {
    const report = masked.value;
    await storage.put(
      `runs/${report.runId}/turns/${report.at}.json`,
      Buffer.from(JSON.stringify(report, null, 2), "utf8"),
      { contentType: "application/json" },
    );
  };
}
