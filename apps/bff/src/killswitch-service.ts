import { KillSwitchSignal } from "@maestro/contracts";
import type { KillSwitchLevel, KillSwitchState, ResolvedDeps } from "./deps.js";
import { SIGNALS } from "./signal-names.js";

/**
 * Two-level kill switch (M58):
 *  · `intake_only` — stop taking new work; everything already running finishes;
 *  · `all`         — stop the work too. Open gates keep waiting: a person who
 *                    has not decided yet still has not decided, and turning a
 *                    pause into a decision is exactly what M29 forbids.
 *
 * Turning it back OFF does not resurrect anything. The runs that received
 * `all` are gone; the switch only governs what happens next.
 */
export interface KillSwitchRequest {
  level: KillSwitchLevel;
  reason: string;
  actor: string;
}

export interface KillSwitchResult {
  state: KillSwitchState;
  /** Runs that were told to stop; empty for `intake_only` and `off`. */
  stopped: string[];
}

export async function operateKillSwitch(
  deps: ResolvedDeps,
  request: KillSwitchRequest,
): Promise<KillSwitchResult> {
  const at = deps.clock.now().toISOString();
  const state: KillSwitchState = {
    level: request.level,
    actor: request.actor,
    reason: request.reason,
    at,
  };

  await deps.killSwitch.set(state);
  await deps.audit.append({
    actor: request.actor,
    action: "KILL_SWITCH",
    subject: "killswitch",
    at,
    meta: { level: request.level, reason: request.reason },
  });

  if (request.level !== "all") return { state, stopped: [] };

  // The signal shape is frozen and has no "off" level, which is the contract
  // agreeing with the semantics: only a stop is broadcast.
  const signal = KillSwitchSignal.parse({
    level: "all",
    actor: request.actor,
    reason: request.reason,
    at,
  });

  const running = await deps.runs.list({ onlyRunning: true });
  const stopped: string[] = [];
  for (const run of running) {
    const delivered = await deps.runs.signal(run.workflowId, SIGNALS.killSwitch, signal);
    if (delivered === "delivered") stopped.push(run.workflowId);
  }
  return { state, stopped };
}
