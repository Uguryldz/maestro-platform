import type { PlatformProfile } from "@maestro/contracts";
import type { RunnerLease, RunnerPort, RunJob, RunResult } from "@maestro/ports";

/**
 * A `RunnerPort` double that behaves like the contract says a runner must —
 * including the parts a lenient fake would let slide, because those are the
 * parts the tests are about.
 *
 * Specifically: it REJECTS on abort rather than returning a result, and it
 * records every acquire/release so a test can assert the lease was handed
 * back. A fake that ignored `signal` would make a kill-switch test pass
 * against a runner that never stops anything.
 */

export interface RecordedJob {
  readonly job: RunJob;
  readonly leaseId: string;
}

export interface FakeRunner extends RunnerPort {
  readonly jobs: RecordedJob[];
  readonly acquired: string[];
  readonly released: string[];
  /** Leases taken but never handed back — must be empty after every turn. */
  leaked(): string[];
}

export interface FakeRunnerOptions {
  /**
   * Answers one command. Matched on the joined command line, longest first, so
   * a test can special-case `git status` and let everything else default.
   */
  readonly responses?: Array<{ match: string; result: Partial<RunResult> }>;
  readonly fallback?: Partial<RunResult>;
  /** Called before each session — where a test fires the kill switch. */
  readonly onSession?: (job: RunJob) => void | Promise<void>;
  /** Fails `release`, to prove a release error cannot mask the real one. */
  readonly failRelease?: boolean;
}

const DEFAULT_RESULT: RunResult = { exitCode: 0, stdoutTail: "", stderrTail: "", durationMs: 5 };

export function fakeRunner(options: FakeRunnerOptions = {}): FakeRunner {
  const jobs: RecordedJob[] = [];
  const acquired: string[] = [];
  const released: string[] = [];
  let seq = 0;

  return {
    jobs,
    acquired,
    released,
    leaked: () => acquired.filter((id) => !released.includes(id)),

    acquire(platform: PlatformProfile): Promise<RunnerLease> {
      seq += 1;
      const leaseId = `lease-${seq}`;
      acquired.push(leaseId);
      return Promise.resolve({ leaseId, runnerId: "runner-1", platform });
    },

    async runSession(lease: RunnerLease, job: RunJob, signal?: AbortSignal): Promise<RunResult> {
      jobs.push({ job, leaseId: lease.leaseId });
      await options.onSession?.(job);

      /**
       * The contract's hard rule: an aborted session tears down and REJECTS.
       * Returning a `RunResult` here — which is what the real bug did — would
       * hand the caller a result it was no longer allowed to act on.
       */
      if (signal?.aborted === true) {
        throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason));
      }

      const line = job.command.join(" ");
      const hit = [...(options.responses ?? [])]
        .sort((a, b) => b.match.length - a.match.length)
        .find((r) => line.includes(r.match));
      return { ...DEFAULT_RESULT, ...(hit?.result ?? options.fallback ?? {}) };
    },

    mountCache(): Promise<void> {
      return Promise.resolve();
    },

    release(lease: RunnerLease): Promise<void> {
      released.push(lease.leaseId);
      return options.failRelease === true
        ? Promise.reject(new Error("pool: release failed"))
        : Promise.resolve();
    },
  };
}

/** Porcelain v1 `-z` output, built from entries so tests stay readable. */
export function porcelainZ(entries: readonly string[]): string {
  return `${entries.join("\0")}\0`;
}
