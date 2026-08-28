import { describe, expect, it } from "vitest";
import { RunnerAgent } from "../src/agent.js";
import { createAgent } from "../src/main.js";
import { FakePlatform } from "./fake-platform.js";
import { agentConfig, FakeClock, FakeRunner, leasedJob } from "./helpers.js";

/**
 * Graceful shutdown's BOUND (task #7) and the composition root.
 *
 * The grace is the one place a real timer is unavoidable, so the tests set it
 * to a few milliseconds rather than sleeping for the configured default.
 */

describe("RunnerAgent — shutdown grace", () => {
  it("aborts a job that outlives the grace, and still tears its sandbox down", async () => {
    const platform = new FakePlatform();
    const runner = new FakeRunner();
    const clock = new FakeClock();
    const agent = new RunnerAgent({
      // Zero grace: the job below never finishes on its own, so the agent must
      // abort it rather than wait. `0` is a value the schema allows.
      config: agentConfig({ shutdownGraceSeconds: 0 }),
      client: platform.client(),
      runner,
      token: () => Promise.resolve("a".repeat(32)),
      now: clock.now,
      runnerPlatform: "macos-xcode",
    });

    let release = (): void => undefined;
    const stuck = new Promise<void>((resolve) => {
      release = resolve;
    });
    runner.onSession = () => stuck;

    await agent.start();
    platform.queue = [leasedJob({ leaseExpiresAt: clock.isoIn(300) })];
    await agent.tick();

    // Does not hang waiting for the stuck job.
    const shutdown = agent.shutdown();
    // The abort lets the fake session return.
    setTimeout(() => release(), 20);
    await shutdown;

    expect(agent.snapshot().state).toBe("stopped");
    expect(runner.released).toEqual(["sandbox-1"]);
  });

  it("a POSITIVE grace is a BOUND: shutdown returns even when the job never ends", async () => {
    const platform = new FakePlatform();
    const runner = new FakeRunner();
    const clock = new FakeClock();
    const agent = new RunnerAgent({
      // A real (short) grace, so the TIMER path runs — the zero-grace test
      // above takes the early-return branch and never exercises it. The bug
      // this guards hung for ever here, which meant SIGKILL and a leaked
      // sandbox.
      config: agentConfig({ shutdownGraceSeconds: 1 }),
      client: platform.client(),
      runner,
      token: () => Promise.resolve("a".repeat(32)),
      now: clock.now,
      runnerPlatform: "macos-xcode",
    });

    let finished = false;
    runner.onSession = async () => {
      // Never finishes on its own: only the abort can end it.
      await new Promise<void>(() => undefined);
      finished = true;
    };

    await agent.start();
    platform.queue = [leasedJob({ leaseExpiresAt: clock.isoIn(300) })];
    await agent.tick();
    await Promise.resolve();

    const startedAt = Date.now();
    const outcome = await Promise.race([
      agent.shutdown({ reasonKey: "runner_agent.shutdown" }).then(() => "returned" as const),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 4_000)),
    ]);
    const elapsedMs = Date.now() - startedAt;

    expect(outcome).toBe("returned");
    // Bounded by the grace, not by the job.
    expect(elapsedMs).toBeLessThan(3_000);
    expect(finished).toBe(false);
    expect(agent.snapshot().state).toBe("stopped");
    // The three things a SIGKILL would have cost us.
    expect(runner.released).toEqual(["sandbox-1"]);
    expect(platform.sent("/agent/bye")).toHaveLength(1);
    // The lease is handed back explicitly, so the platform can reschedule now
    // instead of waiting out the TTL.
    expect(platform.sent("/agent/job/complete")).not.toHaveLength(0);
  });

  it("a driver that IGNORES its abort signal still cannot hold shutdown open", async () => {
    const platform = new FakePlatform();
    const clock = new FakeClock();
    const runner = new FakeRunner();
    // A deliberately DISOBEDIENT driver: it never honours the signal, so the
    // job promise never settles. This is the case the bounded teardown exists
    // for — the previous code awaited that promise unconditionally and hung for
    // ever, which in production means SIGKILL and an orphaned sandbox. A wait
    // that is only bounded when the driver co-operates is not a bound at all.
    runner.runSession = () => new Promise<never>(() => undefined);

    const agent = new RunnerAgent({
      config: agentConfig({ shutdownGraceSeconds: 1 }),
      client: platform.client(),
      runner,
      token: () => Promise.resolve("a".repeat(32)),
      now: clock.now,
      runnerPlatform: "macos-xcode",
    });

    await agent.start();
    platform.queue = [leasedJob({ leaseExpiresAt: clock.isoIn(300) })];
    await agent.tick();
    await Promise.resolve();

    const startedAt = Date.now();
    const outcome = await Promise.race([
      agent.shutdown({ reasonKey: "runner_agent.shutdown" }).then(() => "returned" as const),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 12_000)),
    ]);

    expect(outcome).toBe("returned");
    // Grace (1s) + the teardown window (5s), and no longer.
    expect(Date.now() - startedAt).toBeLessThan(9_000);
    expect(agent.snapshot().state).toBe("stopped");
    // The lease is handed back and the session closed even though the job
    // itself could not be reclaimed.
    expect(platform.sent("/agent/bye")).toHaveLength(1);
  }, 20_000);

  it("returns immediately when nothing is running", async () => {
    const platform = new FakePlatform();
    const agent = new RunnerAgent({
      config: agentConfig({ shutdownGraceSeconds: 3_600 }),
      client: platform.client(),
      runner: new FakeRunner(),
      token: () => Promise.resolve("a".repeat(32)),
      now: new FakeClock().now,
      runnerPlatform: "macos-xcode",
    });
    await agent.start();

    // Would take an hour if the grace were waited out unconditionally.
    await agent.shutdown();

    expect(agent.snapshot().state).toBe("stopped");
  });
});

describe("createAgent — composition root", () => {
  it("builds a working agent from a config and an injected fetch", async () => {
    const platform = new FakePlatform();
    const runner = new FakeRunner();
    const clock = new FakeClock();

    const agent = createAgent({
      config: agentConfig({ tokenRef: { source: "env", key: "TEST_AGENT_TOKEN" } }),
      runner,
      fetch: platform.fetch,
      now: clock.now,
    });

    // The token resolver reads the environment the config points at.
    process.env["TEST_AGENT_TOKEN"] = "b".repeat(32);
    try {
      await agent.start();
      platform.queue = [leasedJob({ leaseExpiresAt: clock.isoIn(300) })];
      await agent.tick();
      await agent.settle();
    } finally {
      delete process.env["TEST_AGENT_TOKEN"];
    }

    expect(agent.sessionId).toBe(platform.sessionId);
    expect(runner.sessions).toHaveLength(1);
    expect(platform.sent("/agent/register")[0]).toHaveProperty("authToken", "b".repeat(32));
  });

  it("maps each agent platform to the matching runner profile", async () => {
    const platform = new FakePlatform();
    const runner = new FakeRunner();
    const clock = new FakeClock();

    const agent = createAgent({
      config: agentConfig({
        platform: "windows-dotnet",
        tokenRef: { source: "env", key: "TEST_AGENT_TOKEN_2" },
      }),
      runner,
      fetch: platform.fetch,
      now: clock.now,
    });

    process.env["TEST_AGENT_TOKEN_2"] = "c".repeat(32);
    try {
      await agent.start();
      platform.queue = [leasedJob({ leaseExpiresAt: clock.isoIn(300) })];
      await agent.tick();
      await agent.settle();
    } finally {
      delete process.env["TEST_AGENT_TOKEN_2"];
    }

    // The sandbox was acquired for the windows profile, not the mac one.
    expect(runner.acquired).toEqual(["windows-dotnet"]);
  });
});
