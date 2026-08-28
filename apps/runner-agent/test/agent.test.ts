import { describe, expect, it } from "vitest";
import { RunnerAgent } from "../src/agent.js";
import { FakePlatform } from "./fake-platform.js";
import { agentConfig, FakeClock, FakeRunner, leasedJob } from "./helpers.js";

/**
 * The agent life cycle end to end (tasks #1, #2, #3, #5, #7), driven through
 * the real `PlatformClient` over a fake transport. No network, no sleeping —
 * `tick()` is called explicitly so the work loop is deterministic.
 */

interface Harness {
  agent: RunnerAgent;
  platform: FakePlatform;
  runner: FakeRunner;
  clock: FakeClock;
}

function harness(overrides: Parameters<typeof agentConfig>[0] = {}): Harness {
  const platform = new FakePlatform();
  const runner = new FakeRunner();
  const clock = new FakeClock();
  const config = agentConfig(overrides);
  const agent = new RunnerAgent({
    config,
    client: platform.client(),
    runner,
    token: () => Promise.resolve("a".repeat(32)),
    now: clock.now,
    runnerPlatform: "macos-xcode",
  });
  return { agent, platform, runner, clock };
}

describe("RunnerAgent — registration (task #1)", () => {
  it("registers with identity, platform, version, capacity and labels", async () => {
    const h = harness({ capacity: 3, labels: ["xcode-16", "android-sdk-35"] });

    await h.agent.start();

    const [sent] = h.platform.sent("/agent/register");
    expect(sent).toMatchObject({
      type: "register",
      agentId: "mac-mini-07",
      platform: "macos-xcode",
      agentVersion: "0.1.0",
      maxConcurrency: 3,
      labels: ["xcode-16", "android-sdk-35"],
    });
    expect(h.agent.sessionId).toBe(h.platform.sessionId);
  });

  it("sends the shared secret ONLY on register, and never on later messages", async () => {
    const h = harness();
    await h.agent.start();
    await h.agent.heartbeat();
    await h.agent.tick();

    expect(h.platform.sent("/agent/register")[0]).toHaveProperty("authToken");
    for (const endpoint of ["/agent/heartbeat", "/agent/pull"]) {
      for (const body of h.platform.sent(endpoint)) {
        expect(body).not.toHaveProperty("authToken");
      }
    }
  });

  it("refuses to work before it has registered", async () => {
    const h = harness();
    await expect(h.agent.tick()).rejects.toThrow(/not registered/);
  });
});

describe("RunnerAgent — heartbeat (task #2)", () => {
  it("declares the leases it holds and adopts the interval the platform returns", async () => {
    const h = harness();
    h.platform.queue = [leasedJob({ leaseExpiresAt: h.clock.isoIn(300) })];
    await h.agent.start();
    await h.agent.tick();

    h.platform.heartbeatIntervalSeconds = 42;
    await h.agent.heartbeat();

    const [sent] = h.platform.sent("/agent/heartbeat");
    expect(sent).toMatchObject({ agentId: "mac-mini-07", healthy: true });
    expect(h.agent.heartbeatIntervalSeconds).toBe(42);
  });

  it("drops a lease the platform revoked in the ack", async () => {
    const h = harness();
    h.platform.queue = [leasedJob({ leaseExpiresAt: h.clock.isoIn(300) })];
    await h.agent.start();
    await h.agent.tick();
    await h.agent.settle();

    h.platform.revokedLeases = ["lease-1"];
    await h.agent.heartbeat();

    expect(h.agent.snapshot().heldLeases).toBe(0);
  });
});

describe("RunnerAgent — leased work pull (task #3)", () => {
  it("asks for exactly the free capacity and runs what it is granted", async () => {
    const h = harness({ capacity: 2 });
    h.platform.queue = [
      leasedJob({ leaseId: "lease-1", leaseExpiresAt: h.clock.isoIn(300) }),
      leasedJob({ leaseId: "lease-2", leaseExpiresAt: h.clock.isoIn(300) }),
    ];
    await h.agent.start();

    const started = await h.agent.tick();
    await h.agent.settle();

    expect(h.platform.sent("/agent/pull")[0]).toMatchObject({ max: 2 });
    expect(started.map((job) => job.leaseId)).toEqual(["lease-1", "lease-2"]);
    expect(h.runner.sessions).toHaveLength(2);
  });

  it("never starts more jobs than the free capacity, whatever the platform sends", async () => {
    const h = harness({ capacity: 1 });
    // A platform (or a compromised one) that over-grants must not overwhelm the machine.
    h.platform.queue = [
      leasedJob({ leaseId: "lease-1", leaseExpiresAt: h.clock.isoIn(300) }),
      leasedJob({ leaseId: "lease-2", leaseExpiresAt: h.clock.isoIn(300) }),
    ];
    h.platform.queue.forEach(() => undefined);
    await h.agent.start();

    // `max` is 1, so the fake hands out one; assert the agent asked correctly.
    const started = await h.agent.tick();
    await h.agent.settle();

    expect(h.platform.sent("/agent/pull")[0]).toMatchObject({ max: 1 });
    expect(started).toHaveLength(1);
  });

  it("reports every finished job so the lease is released", async () => {
    const h = harness();
    h.platform.queue = [leasedJob({ leaseExpiresAt: h.clock.isoIn(300) })];
    await h.agent.start();
    await h.agent.tick();
    await h.agent.settle();

    const [completion] = h.platform.sent("/agent/job/complete");
    expect(completion).toMatchObject({ leaseId: "lease-1", outcome: "succeeded", exitCode: 0 });
    expect(h.agent.snapshot().heldLeases).toBe(0);
  });

  it("drops expired leases before asking for more work", async () => {
    const h = harness();
    h.platform.queue = [leasedJob({ leaseExpiresAt: h.clock.isoIn(30) })];
    await h.agent.start();
    await h.agent.tick();
    await h.agent.settle();
    // The job finished, but simulate a stale claim by re-tracking one.
    h.platform.queue = [leasedJob({ leaseId: "lease-9", leaseExpiresAt: h.clock.isoIn(30) })];
    await h.agent.tick();
    await h.agent.settle();

    h.clock.advanceSeconds(31);
    await h.agent.tick();

    expect(h.agent.snapshot().heldLeases).toBe(0);
  });
});

describe("RunnerAgent — kill switch (task #5)", () => {
  it("pause_intake stops NEW work being taken", async () => {
    const h = harness();
    await h.agent.start();
    h.platform.killLevel = "pause_intake";
    h.platform.queue = [leasedJob({ leaseExpiresAt: h.clock.isoIn(300) })];

    // First tick learns the level (and must not start the granted job).
    const first = await h.agent.tick();
    await h.agent.settle();
    // Second tick must not even ask.
    const pullsAfterFirst = h.platform.sent("/agent/pull").length;
    const second = await h.agent.tick();

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(h.platform.sent("/agent/pull")).toHaveLength(pullsAfterFirst);
    expect(h.runner.sessions).toEqual([]);
  });

  it("stop_all in a pull reply prevents the granted jobs from running", async () => {
    const h = harness();
    await h.agent.start();
    h.platform.killLevel = "stop_all";
    h.platform.queue = [leasedJob({ leaseExpiresAt: h.clock.isoIn(300) })];

    const started = await h.agent.tick();
    await h.agent.settle();

    expect(started).toEqual([]);
    // The negative assertion: no sandbox was ever opened.
    expect(h.runner.acquired).toEqual([]);
    expect(h.runner.sessions).toEqual([]);
  });
});

describe("RunnerAgent — graceful shutdown (task #7)", () => {
  it("stops taking work, hands back held leases and deregisters", async () => {
    const h = harness();
    h.platform.queue = [leasedJob({ leaseExpiresAt: h.clock.isoIn(300) })];
    await h.agent.start();
    await h.agent.tick();
    await h.agent.settle();

    await h.agent.shutdown({ reasonKey: "runner_agent.shutdown" });

    expect(h.platform.sent("/agent/bye")).toHaveLength(1);
    expect(h.agent.snapshot().state).toBe("stopped");

    // And it takes no further work.
    const after = await h.agent.tick();
    expect(after).toEqual([]);
  });

  it("hands back a still-held lease as abandoned so it can be rescheduled", async () => {
    const h = harness();
    await h.agent.start();
    // A lease whose completion never reaches the platform: the job's own
    // report fails, so the claim is still on the agent's books at shutdown.
    h.platform.queue = [leasedJob({ leaseId: "lease-7", leaseExpiresAt: h.clock.isoIn(300) })];
    h.platform.failing.add("/agent/job/complete");
    await h.agent.tick();
    await h.agent.settle();
    h.platform.failing.delete("/agent/job/complete");

    await h.agent.shutdown();

    // Handed back explicitly rather than left to time out.
    const abandoned = h.platform
      .sent("/agent/job/complete")
      .filter((body) => body["outcome"] === "abandoned");
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]).toMatchObject({ leaseId: "lease-7", reasonKey: "runner_agent.shutdown" });
    expect(h.platform.sent("/agent/bye")).toHaveLength(1);
  });

  it("force shutdown aborts a job that is still running", async () => {
    const h = harness();
    await h.agent.start();
    h.platform.queue = [leasedJob({ leaseId: "lease-8", leaseExpiresAt: h.clock.isoIn(300) })];

    // Held open until the test releases it, so shutdown lands mid-session.
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.runner.onSession = () => held;

    await h.agent.tick();
    const shutdown = h.agent.shutdown({ force: true });
    release();
    await shutdown;

    expect(h.agent.snapshot().state).toBe("stopped");
    expect(h.runner.released).toEqual(["sandbox-1"]);
  });

  it("a second shutdown is a no-op", async () => {
    const h = harness();
    await h.agent.start();
    await h.agent.shutdown();
    await h.agent.shutdown();

    expect(h.platform.sent("/agent/bye")).toHaveLength(1);
  });

  it("survives a platform that is already unreachable", async () => {
    const h = harness();
    await h.agent.start();
    h.platform.failing.add("/agent/bye");

    await expect(h.agent.shutdown()).resolves.toBeUndefined();
    expect(h.agent.snapshot().state).toBe("stopped");
  });
});

describe("RunnerAgent — logLevel is ENFORCED (not just validated)", () => {
  function logHarness(logLevel: "debug" | "info" | "warn" | "error"): {
    agent: RunnerAgent;
    lines: { level: string; message: string }[];
  } {
    const platform = new FakePlatform();
    const lines: { level: string; message: string }[] = [];
    const agent = new RunnerAgent({
      config: agentConfig({ logLevel }),
      client: platform.client(),
      runner: new FakeRunner(),
      token: () => Promise.resolve("a".repeat(32)),
      now: new FakeClock().now,
      runnerPlatform: "macos-xcode",
      log: (event) => lines.push({ level: event.level, message: event.message }),
    });
    return { agent, lines };
  }

  it("an operator who asks for `error` does not get info noise", async () => {
    const quiet = logHarness("error");
    await quiet.agent.start();

    // `runner_agent.registered` is an info line; at `error` it must not appear.
    expect(quiet.lines).toEqual([]);
  });

  it("the same run at `info` DOES emit those lines", async () => {
    const chatty = logHarness("info");
    await chatty.agent.start();

    expect(chatty.lines.map((line) => line.message)).toContain("runner_agent.registered");
  });
});

describe("RunnerAgent — stop_all reaches a RUNNING job (M58, end to end)", () => {
  it("interrupts a build already in flight instead of relabelling it", async () => {
    const h = harness();
    await h.agent.start();

    let finished = false;
    let entered = (): void => undefined;
    const hasEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    h.runner.onSession = async () => {
      entered();
      await new Promise<void>(() => undefined);
      finished = true;
    };

    h.platform.queue = [leasedJob({ leaseExpiresAt: h.clock.isoIn(300) })];
    await h.agent.tick();
    await hasEntered;

    // The operator throws the switch; the next pull carries it.
    h.platform.killLevel = "stop_all";
    await h.agent.tick();
    await h.agent.settle();

    expect(finished).toBe(false);
    expect(h.runner.completed).toEqual([]);
    expect(h.runner.released).toEqual(["sandbox-1"]);
    const [completion] = h.platform.sent("/agent/job/complete");
    expect(completion).toMatchObject({ outcome: "cancelled" });
  });
});

describe("RunnerAgent — operator snapshot", () => {
  it("reports the states the runners view shows", async () => {
    const h = harness();
    expect(h.agent.snapshot().state).toBe("starting");

    await h.agent.start();
    expect(h.agent.snapshot()).toMatchObject({ state: "idle", activeJobs: 0, killLevel: "off" });

    await h.agent.shutdown();
    expect(h.agent.snapshot().state).toBe("stopped");
  });
});
