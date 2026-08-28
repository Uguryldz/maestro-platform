import type { PlatformProfile } from "@maestro/contracts";
import type { RunnerPort } from "@maestro/ports";
import { RunnerAgent } from "./agent.js";
import { loadRunnerAgentConfig, type RunnerAgentConfig } from "./config.js";
import { PlatformClient, type FetchLike } from "./platform-client.js";
import { createTokenResolver } from "./token.js";

/**
 * Composition root and process life cycle (tasks #7, #9).
 *
 * The only file allowed to read `process.env`, install signal handlers and
 * schedule timers — everything below it takes its collaborators as arguments,
 * which is why the rest of the app is testable without a process.
 */

/** Platform profile each agent platform runs jobs for (K60 `PlatformProfile`). */
const PLATFORM_PROFILE: Record<RunnerAgentConfig["platform"], PlatformProfile> = {
  "macos-xcode": "macos-xcode",
  "windows-dotnet": "windows-dotnet",
};

export interface StartOptions {
  config: RunnerAgentConfig;
  runner: RunnerPort;
  fetch?: FetchLike;
  now?: () => Date;
  log?: (event: { level: string; message: string; meta?: Record<string, unknown> }) => void;
}

/** Wires the agent. Exported so an operator-facing test can drive the real graph. */
export function createAgent(options: StartOptions): RunnerAgent {
  const { config } = options;
  const token = createTokenResolver({ ref: config.tokenRef });
  const client = new PlatformClient({
    baseUrl: config.platformUrl,
    fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    requestTimeoutMs: config.requestTimeoutMs,
    token,
  });
  return new RunnerAgent({
    config,
    client,
    runner: options.runner,
    token,
    now: options.now ?? (() => new Date()),
    runnerPlatform: PLATFORM_PROFILE[config.platform],
    ...(options.log === undefined ? {} : { log: options.log }),
  });
}

/** Runs the agent until a signal arrives. Resolves once shutdown has completed. */
export async function run(options: StartOptions): Promise<void> {
  const agent = createAgent(options);
  await agent.start();

  let stopping = false;
  const timers: NodeJS.Timeout[] = [];

  const stop = (signal: string): void => {
    // A SECOND signal means the operator is not willing to wait: the first is
    // graceful, the second forces the sandboxes down.
    if (stopping) {
      void agent.shutdown({ force: true, reasonKey: "runner_agent.shutdown" });
      return;
    }
    stopping = true;
    for (const timer of timers) clearInterval(timer);
    void agent
      .shutdown({ reasonKey: "runner_agent.shutdown" })
      .catch(() => undefined)
      .finally(() => {
        process.exitCode = 0;
      });
    options.log?.({ level: "info", message: "runner_agent.signal", meta: { signal } });
  };

  process.on("SIGINT", () => {
    stop("SIGINT");
  });
  process.on("SIGTERM", () => {
    stop("SIGTERM");
  });

  timers.push(
    setInterval(() => {
      void agent.heartbeat().catch(() => undefined);
    }, agent.heartbeatIntervalSeconds * 1_000),
  );
  timers.push(
    setInterval(() => {
      void agent.tick().catch(() => undefined);
    }, options.config.pullIntervalSeconds * 1_000),
  );
}

/** `node src/main.ts` entrypoint. A runner driver must be wired by the deployment. */
export async function mainFromEnv(runner: RunnerPort): Promise<void> {
  // Throws — and therefore refuses to start — on a missing mandatory setting.
  const config = loadRunnerAgentConfig();
  await run({ config, runner });
}
