import type { PlatformProfile } from "@maestro/contracts";

export interface RunnerLease {
  leaseId: string;
  runnerId: string;
  platform: PlatformProfile;
}

export interface RunJob {
  runId: string;
  workspaceKey: string;
  command: string[];
  timeoutSeconds: number;
  env?: Record<string, string>;
}

export interface RunResult {
  exitCode: number;
  stdoutTail: string;
  stderrTail: string;
  durationMs: number;
}

/**
 * Runner port (K60): docker-linux containers + outbound-connected
 * win/mac agents. No inbound ports to runners.
 */
export interface RunnerPort {
  acquire(platform: PlatformProfile): Promise<RunnerLease>;
  /**
   * Run one session to completion, or until `signal` aborts it.
   *
   * `signal` is REQUIRED of implementations and optional to callers, and it is
   * the difference between stopping a build and relabelling one. Without it the
   * only place a caller could react to a kill switch (M58) or a lost lease was
   * between awaits — so a job that had entered `runSession` ran to the end no
   * matter what the platform said, and the caller then wrote "cancelled" on a
   * result it had in fact allowed to finish. Two concrete failures came from
   * that: `stop_all` did not stop a twenty-minute compile, and a job whose
   * lease had been reassigned kept writing the same workspace as its
   * replacement.
   *
   * An implementation MUST tear the session down when the signal fires and
   * reject with the abort reason; returning a normal `RunResult` after an abort
   * would put the caller right back where it started. Releasing the lease stays
   * the caller's job, on every path.
   */
  runSession(lease: RunnerLease, job: RunJob, signal?: AbortSignal): Promise<RunResult>;
  mountCache(lease: RunnerLease, keys: string[]): Promise<void>;
  release(lease: RunnerLease): Promise<void>;
}
