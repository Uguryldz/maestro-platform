import { describe, expect, it } from "vitest";
import { LeaseLostError } from "../src/errors.js";
import { JobRunner } from "../src/job-runner.js";
import { KillSwitchState } from "../src/kill-switch.js";
import { FakeClock, FakeRunner, leasedJob } from "./helpers.js";

/**
 * The sandbox life cycle (task #4) and kill-switch obedience (task #5).
 *
 * Every cancellation test asserts a NEGATIVE — that `runSession` was never
 * reached — because "the job reported cancelled" is also what a broken
 * implementation says after running the work to completion.
 */

/**
 * A promise the test resolves by hand. Used to wait until the session is
 * genuinely in flight: the renewal timer is armed inside the `runSession` call,
 * so a test that ticked before that point would fire an empty timer list and
 * prove nothing.
 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface Harness {
  runner: FakeRunner;
  killSwitch: KillSwitchState;
  clock: FakeClock;
  logs: { stream: string; text: string }[];
  jobRunner: JobRunner;
}

function harness(options: { checkLease?: (leaseId: string) => Promise<void> } = {}): Harness {
  const runner = new FakeRunner();
  const killSwitch = new KillSwitchState();
  const clock = new FakeClock();
  const logs: { stream: string; text: string }[] = [];
  const jobRunner = new JobRunner({
    runner,
    killSwitch,
    platform: "macos-xcode",
    now: clock.now,
    agentToken: "s3cr3t-token-value-abcdefghijkl",
    logSink: async (chunk) => {
      logs.push(chunk);
      await Promise.resolve();
    },
    ...(options.checkLease === undefined ? {} : { checkLease: options.checkLease }),
  });
  return { runner, killSwitch, clock, logs, jobRunner };
}

describe("JobRunner — sandbox life cycle", () => {
  it("acquires, runs and ALWAYS releases the sandbox on the happy path", async () => {
    const h = harness();
    const outcome = await h.jobRunner.run(leasedJob());

    expect(outcome.outcome).toBe("succeeded");
    expect(outcome.exitCode).toBe(0);
    expect(h.runner.sessions).toHaveLength(1);
    expect(h.runner.released).toEqual(["sandbox-1"]);
  });

  it("releases the sandbox when the session THROWS (no leaked sandbox)", async () => {
    const h = harness();
    h.runner.sessionError = new Error("docker daemon died");

    const outcome = await h.jobRunner.run(leasedJob());

    expect(outcome.outcome).toBe("failed");
    // The whole point: the sandbox was still torn down.
    expect(h.runner.released).toEqual(["sandbox-1"]);
  });

  it("does not mask the outcome when release itself fails", async () => {
    const h = harness();
    h.runner.releaseError = new Error("remove failed");

    const outcome = await h.jobRunner.run(leasedJob());

    // The job succeeded; a failing teardown must not rewrite that.
    expect(outcome.outcome).toBe("succeeded");
    expect(h.runner.released).toEqual(["sandbox-1"]);
  });

  it("reports a failed job — not a throw — when no sandbox can be acquired", async () => {
    const h = harness();
    h.runner.acquireError = new Error("no capacity");

    const outcome = await h.jobRunner.run(leasedJob());

    expect(outcome.outcome).toBe("failed");
    expect(outcome.reasonKey).toBe("runner_agent.sandbox_acquire_failed");
    expect(h.runner.released).toEqual([]);
  });

  it("maps a non-zero exit code to a failed job", async () => {
    const h = harness();
    h.runner.result = { exitCode: 1, stdoutTail: "", stderrTail: "boom", durationMs: 9 };

    const outcome = await h.jobRunner.run(leasedJob());

    expect(outcome.outcome).toBe("failed");
    expect(outcome.exitCode).toBe(1);
  });
});

describe("JobRunner — kill switch (task #5)", () => {
  it("stop_all BEFORE the job starts: the sandbox is never acquired", async () => {
    const h = harness();
    h.killSwitch.apply("stop_all");

    const outcome = await h.jobRunner.run(leasedJob());

    expect(outcome.outcome).toBe("cancelled");
    expect(outcome.stoppedAt).toBe("acquire");
    // The negative assertion that makes this test mean something.
    expect(h.runner.acquired).toEqual([]);
    expect(h.runner.sessions).toEqual([]);
  });

  it("stop_all flipped while the sandbox is held: runSession is never reached", async () => {
    const h = harness({
      // The step boundary between "sandbox acquired" and "work started".
      checkLease: async () => {
        h.killSwitch.apply("stop_all");
        await Promise.resolve();
      },
    });

    const outcome = await h.jobRunner.run(leasedJob());

    expect(outcome.outcome).toBe("cancelled");
    expect(h.runner.acquired).toHaveLength(1);
    expect(h.runner.sessions).toEqual([]);
    // Still released: a cancelled job must not leak its sandbox either.
    expect(h.runner.released).toEqual(["sandbox-1"]);
  });

  it("pause_intake does NOT stop a job that is already running", async () => {
    const h = harness();
    h.killSwitch.apply("pause_intake");

    const outcome = await h.jobRunner.run(leasedJob());

    expect(outcome.outcome).toBe("succeeded");
    expect(h.runner.sessions).toHaveLength(1);
  });

  it("stop_all raised DURING a long build INTERRUPTS it — the build never finishes", async () => {
    const h = harness();
    // A build that would never end on its own. If the kill switch could not
    // reach into the session, this test would hang rather than pass — which is
    // the point: the previous version of it asserted only the LABEL, and passed
    // against an implementation that let the build run to completion first.
    let finished = false;
    h.runner.onSession = async () => {
      h.killSwitch.apply("stop_all");
      await new Promise<void>(() => undefined);
      finished = true;
    };

    const outcome = await h.jobRunner.run(leasedJob());

    expect(outcome.outcome).toBe("cancelled");
    expect(outcome.reasonKey).toBe("runner_agent.cancelled_kill_switch");
    // The session was ENTERED and then cut short.
    expect(h.runner.sessions).toHaveLength(1);
    expect(finished).toBe(false);
    expect(h.runner.completed).toEqual([]);
    // Still torn down: an interrupted job must not leak its sandbox.
    expect(h.runner.released).toEqual(["sandbox-1"]);
  });

  it("stop_all reaches a build that is ALREADY running (the four-hour-build case)", async () => {
    const h = harness();
    let entered = (): void => undefined;
    const hasEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finished = false;
    h.runner.onSession = async () => {
      entered();
      await new Promise<void>(() => undefined);
      finished = true;
    };

    const running = h.jobRunner.run(leasedJob());
    // The operator hits the switch only once the build is well under way.
    await hasEntered;
    h.killSwitch.apply("stop_all");

    const outcome = await running;

    expect(outcome.outcome).toBe("cancelled");
    expect(finished).toBe(false);
    expect(h.runner.completed).toEqual([]);
    expect(h.runner.released).toEqual(["sandbox-1"]);
  });

  it("a build the switch never touches runs to completion (the abort is not fired blindly)", async () => {
    const h = harness();
    const outcome = await h.jobRunner.run(leasedJob());

    expect(outcome.outcome).toBe("succeeded");
    expect(h.runner.completed).toEqual(["sandbox-1"]);
  });

  it("a job registered while stop_all is already down is aborted immediately", () => {
    const killSwitch = new KillSwitchState();
    killSwitch.apply("stop_all");
    const reasons: string[] = [];

    killSwitch.track({ abort: (reason) => reasons.push(reason) });

    expect(reasons).toEqual(["kill_switch_stop_all"]);
  });

  it("untracking a finished job keeps the running set from growing", () => {
    const killSwitch = new KillSwitchState();
    const untrack = killSwitch.track({ abort: () => undefined });
    expect(killSwitch.runningCount).toBe(1);
    untrack();
    expect(killSwitch.runningCount).toBe(0);
  });
});

describe("JobRunner — lease renewal WHILE the job runs (task #3)", () => {
  it("re-asserts the lease repeatedly during a long session, not once before it", async () => {
    const runner = new FakeRunner();
    const checked: string[] = [];
    const ticks: (() => void)[] = [];
    const gate = deferred();
    let finishBuild = (): void => undefined;
    const build = new Promise<void>((resolve) => {
      finishBuild = resolve;
    });
    runner.onSession = () => {
      gate.resolve();
      return build;
    };

    const jobRunner = new JobRunner({
      runner,
      killSwitch: new KillSwitchState(),
      platform: "macos-xcode",
      now: new FakeClock().now,
      agentToken: "a".repeat(32),
      logSink: async () => {
        await Promise.resolve();
      },
      checkLease: async (leaseId) => {
        checked.push(leaseId);
        await Promise.resolve();
      },
      leaseRenewIntervalMs: 30_000,
      setTimer: (fn) => {
        ticks.push(fn);
        return { unref: () => undefined } as never;
      },
      clearTimer: () => undefined,
    });

    const running = jobRunner.run(leasedJob());
    await gate.promise;
    // Three renewal ticks while the build is still going.
    for (let i = 0; i < 3; i += 1) {
      for (const tick of ticks) tick();
      await Promise.resolve();
    }
    finishBuild();
    const outcome = await running;

    expect(outcome.outcome).toBe("succeeded");
    // One check at the step boundary + three from the loop. The bug this
    // guards was EXACTLY one, ever.
    expect(checked.length).toBeGreaterThanOrEqual(4);
  });

  it("a REFUSED renewal mid-build interrupts the job instead of letting it finish", async () => {
    const runner = new FakeRunner();
    const ticks: (() => void)[] = [];
    const gate = deferred();
    let finished = false;
    runner.onSession = async () => {
      gate.resolve();
      await new Promise<void>(() => undefined);
      finished = true;
    };

    let calls = 0;
    const jobRunner = new JobRunner({
      runner,
      killSwitch: new KillSwitchState(),
      platform: "macos-xcode",
      now: new FakeClock().now,
      agentToken: "a".repeat(32),
      logSink: async () => {
        await Promise.resolve();
      },
      checkLease: async (leaseId) => {
        calls += 1;
        // The boundary check passes; the platform reassigns the lease later.
        if (calls > 1) throw new LeaseLostError(leaseId, "revoked");
        await Promise.resolve();
      },
      leaseRenewIntervalMs: 30_000,
      setTimer: (fn) => {
        ticks.push(fn);
        return { unref: () => undefined } as never;
      },
      clearTimer: () => undefined,
    });

    const running = jobRunner.run(leasedJob());
    await gate.promise;
    for (const tick of ticks) tick();
    const outcome = await running;

    expect(outcome.outcome).toBe("cancelled");
    expect(outcome.reasonKey).toBe("runner_agent.cancelled_lease_lost");
    // The double-run this prevents: the job did NOT finish under a lease that
    // had been handed to somebody else.
    expect(finished).toBe(false);
    expect(runner.completed).toEqual([]);
    expect(runner.released).toEqual(["sandbox-1"]);
  });

  it("an UNREACHABLE platform does not kill a healthy build", async () => {
    const runner = new FakeRunner();
    const ticks: (() => void)[] = [];
    const gate = deferred();
    let finishBuild = (): void => undefined;
    const build = new Promise<void>((resolve) => {
      finishBuild = resolve;
    });
    runner.onSession = () => {
      gate.resolve();
      return build;
    };

    let calls = 0;
    const jobRunner = new JobRunner({
      runner,
      killSwitch: new KillSwitchState(),
      platform: "macos-xcode",
      now: new FakeClock().now,
      agentToken: "a".repeat(32),
      logSink: async () => {
        await Promise.resolve();
      },
      checkLease: async () => {
        calls += 1;
        if (calls > 1) throw new Error("platform unreachable");
        await Promise.resolve();
      },
      leaseRenewIntervalMs: 30_000,
      setTimer: (fn) => {
        ticks.push(fn);
        return { unref: () => undefined } as never;
      },
      clearTimer: () => undefined,
    });

    const running = jobRunner.run(leasedJob());
    await gate.promise;
    for (const tick of ticks) tick();
    await Promise.resolve();
    finishBuild();

    // A transport failure is not a reassignment: killing the build over one
    // would be an outage of its own.
    expect((await running).outcome).toBe("succeeded");
  });

  it("stops renewing once the session has ended", async () => {
    const runner = new FakeRunner();
    const ticks: (() => void)[] = [];
    let cleared = 0;
    const checked: string[] = [];

    const jobRunner = new JobRunner({
      runner,
      killSwitch: new KillSwitchState(),
      platform: "macos-xcode",
      now: new FakeClock().now,
      agentToken: "a".repeat(32),
      logSink: async () => {
        await Promise.resolve();
      },
      checkLease: async (leaseId) => {
        checked.push(leaseId);
        await Promise.resolve();
      },
      leaseRenewIntervalMs: 30_000,
      setTimer: (fn) => {
        ticks.push(fn);
        return { unref: () => undefined } as never;
      },
      clearTimer: () => {
        cleared += 1;
      },
    });

    await jobRunner.run(leasedJob());
    const afterRun = checked.length;
    // A timer that outlived its job would renew a lease nobody is using.
    expect(cleared).toBe(1);
    for (const tick of ticks) tick();
    await Promise.resolve();
    expect(checked.length).toBe(afterRun);
  });
});

describe("JobRunner — lease loss (task #3)", () => {
  it("stops before running when the lease is no longer ours", async () => {
    const h = harness({
      checkLease: (leaseId) => Promise.reject(new LeaseLostError(leaseId, "revoked")),
    });

    const outcome = await h.jobRunner.run(leasedJob());

    expect(outcome.outcome).toBe("cancelled");
    expect(outcome.reasonKey).toBe("runner_agent.cancelled_lease_lost");
    // A double-run is exactly what this prevents.
    expect(h.runner.sessions).toEqual([]);
    expect(h.runner.released).toEqual(["sandbox-1"]);
  });
});

describe("JobRunner — masked log streaming (task #6)", () => {
  it("never streams the agent token, even when the job echoes it", async () => {
    const h = harness();
    const token = "s3cr3t-token-value-abcdefghijkl";
    h.runner.result = {
      exitCode: 0,
      stdoutTail: `authorization: Bearer ${token}`,
      stderrTail: "",
      durationMs: 3,
    };

    await h.jobRunner.run(leasedJob());

    const streamed = h.logs.map((entry) => entry.text).join("\n");
    expect(streamed).not.toContain(token);
    expect(streamed).toContain("[REDACTED]");
  });

  it("never streams a secret carried in the job environment", async () => {
    const h = harness();
    const password = "hunter2-hunter2-hunter2";
    h.runner.result = {
      exitCode: 1,
      stdoutTail: "",
      stderrTail: `fatal: could not authenticate with ${password}`,
      durationMs: 3,
    };

    await h.jobRunner.run(leasedJob({ env: { GIT_PASSWORD: password } }));

    const streamed = h.logs.map((entry) => entry.text).join("\n");
    expect(streamed).not.toContain(password);
    expect(streamed).toContain("[REDACTED]");
  });

  it("a failing log sink does not fail the job", async () => {
    const runner = new FakeRunner();
    runner.result = { exitCode: 0, stdoutTail: "hello", stderrTail: "", durationMs: 1 };
    const jobRunner = new JobRunner({
      runner,
      killSwitch: new KillSwitchState(),
      platform: "macos-xcode",
      now: new FakeClock().now,
      agentToken: "a".repeat(32),
      logSink: () => Promise.reject(new Error("platform unreachable")),
    });

    const outcome = await jobRunner.run(leasedJob());

    expect(outcome.outcome).toBe("succeeded");
    expect(runner.released).toEqual(["sandbox-1"]);
  });
});
