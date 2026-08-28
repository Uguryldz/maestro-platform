import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRunnerAgentConfig } from "../src/config.js";
import { RunnerAgentConfigError } from "../src/errors.js";

/**
 * Configuration (task #9). The property is fail-closed: a missing mandatory
 * setting must REFUSE to start, because every default this file could invent
 * is a security decision nobody made.
 */

const COMPLETE_ENV: Record<string, string> = {
  MAESTRO_AGENT_PLATFORM_URL: "https://maestro.internal",
  MAESTRO_AGENT_ID: "mac-mini-07",
  MAESTRO_AGENT_PLATFORM: "macos-xcode",
  MAESTRO_AGENT_VERSION: "0.1.0",
  MAESTRO_AGENT_CAPACITY: "2",
  MAESTRO_AGENT_TOKEN_SOURCE: "env",
  MAESTRO_AGENT_TOKEN_KEY: "MAESTRO_AGENT_TOKEN",
};

function writeConfigFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "maestro-agent-"));
  const path = join(dir, "agent.json");
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
  return path;
}

describe("loadRunnerAgentConfig — fail-closed", () => {
  it("loads a complete environment", () => {
    const config = loadRunnerAgentConfig({ env: COMPLETE_ENV });

    expect(config).toMatchObject({
      platformUrl: "https://maestro.internal",
      agentId: "mac-mini-07",
      platform: "macos-xcode",
      capacity: 2,
      tokenRef: { source: "env", key: "MAESTRO_AGENT_TOKEN" },
    });
    // Documented defaults, not silent ones.
    expect(config.logLevel).toBe("info");
    expect(config.pullIntervalSeconds).toBe(5);
  });

  for (const missing of Object.keys(COMPLETE_ENV)) {
    it(`refuses to start when ${missing} is absent`, () => {
      const env = { ...COMPLETE_ENV };
      delete env[missing];
      expect(() => loadRunnerAgentConfig({ env })).toThrow(RunnerAgentConfigError);
    });
  }

  it("has no workDir: a MANDATORY setting nothing reads is a promise the agent cannot keep", () => {
    // It used to be required, so an operator who set it believed they had
    // chosen where the bank's source landed. Nothing read it. If it ever comes
    // back, it has to come back with a consumer.
    const config = loadRunnerAgentConfig({ env: COMPLETE_ENV });

    expect(config).not.toHaveProperty("workDir");
    // And a stale one left in a config file is ignored rather than honoured.
    const path = writeConfigFile({
      platformUrl: "https://maestro.internal",
      agentId: "mac-mini-07",
      platform: "macos-xcode",
      agentVersion: "0.1.0",
      capacity: 1,
      workDir: "/var/maestro/agent",
      tokenRef: { source: "env", key: "MAESTRO_AGENT_TOKEN" },
    });
    expect(loadRunnerAgentConfig({ env: {}, configPath: path })).not.toHaveProperty("workDir");
  });

  it("refuses a capacity that is not an integer instead of coercing it to NaN", () => {
    expect(() =>
      loadRunnerAgentConfig({ env: { ...COMPLETE_ENV, MAESTRO_AGENT_CAPACITY: "two" } }),
    ).toThrow(/must be an integer/);
  });

  it("refuses an unknown platform", () => {
    expect(() =>
      loadRunnerAgentConfig({ env: { ...COMPLETE_ENV, MAESTRO_AGENT_PLATFORM: "linux-node" } }),
    ).toThrow(RunnerAgentConfigError);
  });

  it("refuses plaintext http in production — the shared secret would be on the wire", () => {
    expect(() =>
      loadRunnerAgentConfig({
        env: { ...COMPLETE_ENV, MAESTRO_AGENT_PLATFORM_URL: "http://maestro.internal", NODE_ENV: "production" },
      }),
    ).toThrow(/https/);
  });

  it("has NO way to put the token itself in the config", () => {
    const path = writeConfigFile({
      ...{
        platformUrl: "https://maestro.internal",
        agentId: "mac-mini-07",
        platform: "macos-xcode",
        agentVersion: "0.1.0",
        capacity: 1,
        workDir: "/var/maestro/agent",
      },
      // A literal source must not be accepted: it would be a plaintext
      // credential on disk (task #1).
      tokenRef: { source: "literal", key: "super-secret-value" },
    });

    expect(() => loadRunnerAgentConfig({ env: {}, configPath: path })).toThrow(RunnerAgentConfigError);
  });
});

describe("loadRunnerAgentConfig — file and environment", () => {
  it("reads a config file and lets the environment override it", () => {
    const path = writeConfigFile({
      platformUrl: "https://from-file.internal",
      agentId: "mac-mini-01",
      platform: "macos-xcode",
      agentVersion: "0.0.9",
      capacity: 1,
      workDir: "/var/maestro/agent",
      tokenRef: { source: "env", key: "TOKEN_FROM_FILE" },
      labels: ["xcode-15"],
    });

    const config = loadRunnerAgentConfig({
      env: { MAESTRO_AGENT_CAPACITY: "4", MAESTRO_AGENT_ID: "mac-mini-99" },
      configPath: path,
    });

    // Env wins where it speaks…
    expect(config.capacity).toBe(4);
    expect(config.agentId).toBe("mac-mini-99");
    // …and the file is kept where it does not.
    expect(config.platformUrl).toBe("https://from-file.internal");
    expect(config.labels).toEqual(["xcode-15"]);
  });

  it("refuses a config file that is not JSON", () => {
    const path = writeConfigFile("not json at all");
    expect(() => loadRunnerAgentConfig({ env: {}, configPath: path })).toThrow(/not valid JSON/);
  });

  it("refuses a config file that cannot be read", () => {
    expect(() => loadRunnerAgentConfig({ env: {}, configPath: "/nonexistent/agent.json" })).toThrow(
      /cannot be read/,
    );
  });

  it("parses a comma-separated label list from the environment", () => {
    const config = loadRunnerAgentConfig({
      env: { ...COMPLETE_ENV, MAESTRO_AGENT_LABELS: "xcode-16, android-sdk-35 ,vs2022" },
    });
    expect(config.labels).toEqual(["xcode-16", "android-sdk-35", "vs2022"]);
  });
});
