import type { PlatformProfile } from "@maestro/contracts";
import type { RunnerPort } from "@maestro/ports";
import type { KillSwitchState } from "./kill-switch.js";
import { JobRunner, type JobOutcome } from "./job-runner.js";
import type { LeaseManager } from "./lease-manager.js";
import type { PlatformClient } from "./platform-client.js";
import type { LeasedJob } from "./protocol.js";

/**
 * One leased job, from "the platform granted it" to "the platform knows how it
 * ended". Split out of `agent.ts` so the life-cycle class stays about the life
 * cycle: this file owns the reporting rules, `job-runner.ts` owns the sandbox.
 */

export interface ExecuteJobDeps {
  client: PlatformClient;
  runner: RunnerPort;
  killSwitch: KillSwitchState;
  leases: LeaseManager;
  sessionId: string;
  agentId: string;
  runnerPlatform: PlatformProfile;
  now: () => Date;
  token: () => Promise<string>;
  log: (level: string, message: string, meta?: Record<string, unknown>) => void;
  /** How often the lease is re-asserted while the session is in flight. */
  leaseRenewIntervalMs: number;
}

export async function executeJob(deps: ExecuteJobDeps, job: LeasedJob): Promise<void> {
  const token = await deps.token();
  const runner = new JobRunner({
    runner: deps.runner,
    killSwitch: deps.killSwitch,
    platform: deps.runnerPlatform,
    now: deps.now,
    agentToken: token,
    logSink: async (chunk) => {
      await deps.client.sendLog({
        sessionId: deps.sessionId,
        agentId: deps.agentId,
        leaseId: job.leaseId,
        runId: job.runId,
        stream: chunk.stream,
        text: chunk.text,
        at: deps.now().toISOString(),
      });
    },
    // The lease is re-verified at the step boundary AND on a timer for as long
    // as the session runs; the renewal reply is also how a `stop_all` reaches a
    // job that is already running.
    checkLease: (leaseId) => deps.leases.assertHeld(leaseId),
    leaseRenewIntervalMs: deps.leaseRenewIntervalMs,
  });

  let outcome: JobOutcome;
  try {
    outcome = await runner.run(job);
  } catch {
    // `JobRunner.run` is written not to throw; this is the belt to that
    // braces, because an escaped exception here would leave the lease dangling
    // with nothing ever reporting it.
    outcome = { outcome: "failed", durationMs: 0, reasonKey: "runner_agent.job_failed" };
  }

  // The lease is forgotten only once the platform has been TOLD the job is
  // over. Forgetting first loses the claim on a failed report: the agent stops
  // renewing it and stops handing it back at shutdown, so the work sits until
  // the full lease TTL burns down instead of being rescheduled at once.
  try {
    await deps.client.completeJob({
      sessionId: deps.sessionId,
      agentId: deps.agentId,
      leaseId: job.leaseId,
      runId: job.runId,
      outcome: outcome.outcome,
      ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
      durationMs: outcome.durationMs,
      ...(outcome.reasonKey === undefined ? {} : { reasonKey: outcome.reasonKey }),
      at: deps.now().toISOString(),
    });
    deps.leases.forget(job.leaseId);
  } catch {
    deps.log("warn", "runner_agent.job_failed", { leaseId: job.leaseId });
  }
}
