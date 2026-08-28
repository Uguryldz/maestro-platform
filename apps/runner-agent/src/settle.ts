/**
 * The BOUND on graceful shutdown (task #7).
 *
 * Split out of `agent.ts` because it is the one piece of that file with a
 * safety argument of its own: how long the process is allowed to wait for work
 * that may never end.
 *
 * A service manager (launchd/nssm) that gives up waiting sends SIGKILL, and a
 * SIGKILL'd agent never runs `release()` — so its sandbox is orphaned with the
 * bank's source still in it. Every wait here is therefore finite, including the
 * one AFTER the sessions have been aborted: a wait that is only bounded when
 * the runner driver co-operates is not a bound at all.
 */

/**
 * How long teardown is awaited after the sessions have been aborted. Short: the
 * abort is what stops the work, this only gives `release` time to finish so the
 * sandbox is gone before the process is.
 */
export const TEARDOWN_WINDOW_MS = 5_000;

export interface SettleDeps {
  /** Resolves when every running job has finished. */
  settle: () => Promise<void>;
  /** How many jobs are still running. */
  activeJobs: () => number;
  /** Aborts every running session, so `runSession` rejects and tears down. */
  abortAll: (reason: string) => void;
  log: (level: string, message: string, meta?: Record<string, unknown>) => void;
}

/**
 * Waits for the running jobs, but never for longer than the grace plus the
 * teardown window. Returns once it is safe to continue shutting down — handing
 * the leases back and sending `bye` — whether or not the jobs actually ended.
 */
export async function settleWithin(deps: SettleDeps, graceMs: number): Promise<void> {
  if (deps.activeJobs() === 0) return;
  if (graceMs > 0 && (await raceSettle(deps.settle, graceMs)) === "settled") return;

  deps.log("warn", "runner_agent.shutdown");
  deps.abortAll("shutdown");
  if ((await raceSettle(deps.settle, TEARDOWN_WINDOW_MS)) === "timeout") {
    // The jobs did not end even after being aborted. Nothing further can be
    // awaited without risking the SIGKILL this whole path exists to avoid.
    deps.log("warn", "runner_agent.shutdown_forced", { activeJobs: deps.activeJobs() });
  }
}

/** Settles, or gives up after `limitMs`. Never leaves a timer behind. */
async function raceSettle(settle: () => Promise<void>, limitMs: number): Promise<"settled" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), limitMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([settle().then(() => "settled" as const), expired]);
  } finally {
    clearTimeout(timer);
  }
}
