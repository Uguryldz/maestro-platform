import type { RunJob } from "@maestro/ports";
import { describe, expect, it } from "vitest";
import { DockerRunnerConfig } from "../src/config.js";
import { RunnerConfigError } from "../src/errors.js";
import { buildContainerSpec, containerName, egressNetworkMode, sandboxBinds, sandboxEnv } from "../src/sandbox.js";
import { cacheMountPath, WORKSPACE_MOUNT_PATH, workspaceVolumeName } from "../src/workspace.js";
import { TEST_CONFIG, TEST_IMAGE, TEST_JOB } from "./helpers.js";

const config = DockerRunnerConfig.parse(TEST_CONFIG);
const airGapped = DockerRunnerConfig.parse({ platforms: TEST_CONFIG.platforms });

function spec(overrides: Partial<RunJob> = {}, cfg = config, cacheKeys: string[] = []) {
  return buildContainerSpec({
    config: cfg,
    image: TEST_IMAGE,
    job: { ...TEST_JOB, ...overrides },
    leaseId: "lease-00000001",
    platform: "linux-node",
    cacheKeys,
  });
}

function hostConfig(container = spec()): Record<string, unknown> {
  return container["HostConfig"] as Record<string, unknown>;
}

describe("hardened container profile (M23)", () => {
  it("drops every capability and forbids regaining privileges", () => {
    const host = hostConfig();

    expect(host["CapDrop"]).toEqual(["ALL"]);
    expect(host["CapAdd"]).toEqual([]);
    expect(host["SecurityOpt"]).toContain("no-new-privileges:true");
    expect(host["Privileged"]).toBe(false);
  });

  it("says NOTHING about seccomp so the daemon's default filter stays on", () => {
    // Engine 29.4 parses any other `seccomp=` value as a profile document and
    // refuses to start the container — fixtures/containers-start-bad-seccomp.http.
    expect(hostConfig()["SecurityOpt"]).toEqual(["no-new-privileges:true"]);
  });

  it("only ever emits seccomp=unconfined as an explicitly allowed relaxation", () => {
    const relaxed = DockerRunnerConfig.parse({
      ...TEST_CONFIG,
      sandbox: { seccomp: "unconfined", allowUnsafeProfile: ["seccomp"] },
    });

    expect(hostConfig(spec({}, relaxed))["SecurityOpt"]).toEqual(["no-new-privileges:true", "seccomp=unconfined"]);
  });

  it("runs read-only as a non-root user with a bounded tmpfs", () => {
    const container = spec();

    expect(container["User"]).toBe("10001:10001");
    expect(hostConfig()["ReadonlyRootfs"]).toBe(true);
    expect(hostConfig()["Tmpfs"]).toEqual({ "/tmp": "rw,noexec,nosuid,nodev,size=512m" });
  });

  it("applies memory, cpu and pid limits, with swap disabled", () => {
    const host = hostConfig();

    expect(host["Memory"]).toBe(2_048 * 1_024 * 1_024);
    // A memory limit that may swap is a suggestion, not a limit.
    expect(host["MemorySwap"]).toBe(host["Memory"]);
    expect(host["NanoCpus"]).toBe(2_000_000_000);
    expect(host["PidsLimit"]).toBe(256);
    expect(host["Ulimits"]).toEqual([{ Name: "nofile", Soft: 4_096, Hard: 4_096 }]);
  });

  it("is ephemeral: no restart policy, and PID 1 reaps children", () => {
    expect(hostConfig()["RestartPolicy"]).toEqual({ Name: "no" });
    expect(hostConfig()["Init"]).toBe(true);
    expect(hostConfig()["AutoRemove"]).toBe(false);
  });

  it("passes the configured runtime through for gVisor (M23 stage 3)", () => {
    const gvisor = DockerRunnerConfig.parse({ ...TEST_CONFIG, sandbox: { runtime: "runsc" } });

    expect(hostConfig(spec({}, gvisor))["Runtime"]).toBe("runsc");
    expect(hostConfig()).not.toHaveProperty("Runtime");
  });

  it("refuses to build a spec from a profile that would not pass the gate", () => {
    const forged = { ...config, sandbox: { ...config.sandbox, user: "0:0" } };

    expect(() => spec({}, forged)).toThrow(RunnerConfigError);
  });

  it("refuses an image that is not digest-pinned even if the config was", () => {
    expect(() =>
      buildContainerSpec({
        config,
        image: "node:22",
        job: TEST_JOB,
        leaseId: "lease-1",
        platform: "linux-node",
        cacheKeys: [],
      }),
    ).toThrow(/digest-pinned/);
  });

  it("refuses an empty command", () => {
    expect(() => spec({ command: [] })).toThrow(/command is empty/);
  });
});

describe("egress (M26)", () => {
  it("has no network at all when nothing is configured", () => {
    expect(egressNetworkMode(airGapped.egress)).toBe("none");
    expect(hostConfig(spec({}, airGapped))["NetworkMode"]).toBe("none");
    expect(spec({}, airGapped)["NetworkDisabled"]).toBe(true);
  });

  it("attaches only the egress network when a proxy is configured", () => {
    expect(hostConfig()["NetworkMode"]).toBe("maestro-egress");
    expect(spec()["NetworkDisabled"]).toBe(false);
  });

  it("exports the proxy in both spellings, plus a NO_PROXY list", () => {
    const env = sandboxEnv(config, TEST_JOB);

    expect(env).toContain("HTTP_PROXY=http://egress.internal.bank:3128");
    expect(env).toContain("https_proxy=http://egress.internal.bank:3128");
    expect(env.find((entry) => entry.startsWith("NO_PROXY="))).toContain("127.0.0.1");
  });

  it("refuses a job that tries to redirect its own egress", () => {
    expect(() => sandboxEnv(config, { ...TEST_JOB, env: { HTTP_PROXY: "http://attacker" } })).toThrow(/egress policy/);
    expect(() => sandboxEnv(config, { ...TEST_JOB, env: { no_proxy: "*" } })).toThrow(/egress policy/);
    // curl, git and the Go toolchain all honour ALL_PROXY too, so leaving it
    // out of the reserved list left the job one variable away from its own
    // (unaudited) route out.
    expect(() => sandboxEnv(config, { ...TEST_JOB, env: { ALL_PROXY: "socks5://attacker" } })).toThrow(/egress policy/);
    expect(() => sandboxEnv(config, { ...TEST_JOB, env: { all_proxy: "socks5://attacker" } })).toThrow(/egress policy/);
  });

  it("refuses loader variables that would run code before the command", () => {
    for (const name of ["LD_PRELOAD", "NODE_OPTIONS", "BASH_ENV"]) {
      expect(() => sandboxEnv(config, { ...TEST_JOB, env: { [name]: "x" } })).toThrow(RunnerConfigError);
    }
  });

  it("refuses malformed variable names and NUL bytes", () => {
    expect(() => sandboxEnv(config, { ...TEST_JOB, env: { "BAD NAME": "x" } })).toThrow(/valid name/);
    expect(() => sandboxEnv(config, { ...TEST_JOB, env: { GOOD: "a\0b" } })).toThrow(/NUL/);
  });

  it("keeps the job's own variables and always sets HOME inside the workspace", () => {
    const env = sandboxEnv(config, { ...TEST_JOB, env: { CI: "true" } });

    expect(env).toContain("CI=true");
    expect(env).toContain(`HOME=${WORKSPACE_MOUNT_PATH}`);
    expect(env).toContain(`MAESTRO_RUN_ID=${TEST_JOB.runId}`);
  });
});

describe("volumes (M31)", () => {
  it("mounts the ticket workspace read-write", () => {
    const binds = sandboxBinds(config, TEST_JOB, []);

    expect(binds).toEqual([`${workspaceVolumeName(TEST_JOB.workspaceKey)}:${WORKSPACE_MOUNT_PATH}:rw`]);
  });

  it("mounts dependency caches read-only by default — one ticket cannot poison another", () => {
    const binds = sandboxBinds(config, TEST_JOB, ["dep-linux-node-npm-abc123"]);

    // The volume name is pinned on purpose: it is what survives on disk
    // between runs, so changing it silently would orphan every warm cache.
    expect(binds[1]).toBe(
      `maestro-cache-dep-linux-node-npm-abc123-dde7e49e1f38:${cacheMountPath("dep-linux-node-npm-abc123")}:ro`,
    );
  });

  it("mounts caches read-write only when the operator asks for it", () => {
    const writable = DockerRunnerConfig.parse({ ...TEST_CONFIG, workspace: { cacheReadOnly: false } });

    expect(sandboxBinds(writable, TEST_JOB, ["dep-x"])[1]?.endsWith(":rw")).toBe(true);
  });

  it("refuses a cache key that could escape its mount point", () => {
    expect(() => sandboxBinds(config, TEST_JOB, ["../etc"])).toThrow(/invalid runner key/);
  });

  it("labels the container so an orphan can be traced back to its run", () => {
    const labels = spec()["Labels"] as Record<string, string>;

    expect(labels).toMatchObject({
      "maestro.managed": "true",
      "maestro.run-id": TEST_JOB.runId,
      "maestro.lease-id": "lease-00000001",
      "maestro.platform": "linux-node",
    });
  });
});

describe("container naming", () => {
  it("is deterministic, lower-case and within Docker's length limit", () => {
    const name = containerName(config, TEST_JOB, "lease-00000001");

    expect(name).toBe(containerName(config, TEST_JOB, "lease-00000001"));
    expect(name).toMatch(/^maestro-[a-z0-9-]+$/);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it("separates two leases of the same run", () => {
    expect(containerName(config, TEST_JOB, "lease-1")).not.toBe(containerName(config, TEST_JOB, "lease-2"));
  });

  /**
   * O1: the name used to be `prefix + runId + leaseId` cut to 63 characters,
   * so two long run ids sharing a prefix produced ONE name — and the second
   * `containers/create` came back 409 while the audit trail pointed both runs
   * at the same container.
   */
  it("keeps long run ids apart instead of truncating them onto one name", () => {
    const long = `run-${"a".repeat(80)}`;
    const alsoLong = `run-${"a".repeat(79)}b`;

    const first = containerName(config, { ...TEST_JOB, runId: long }, "lease-00000001");
    const second = containerName(config, { ...TEST_JOB, runId: alsoLong }, "lease-00000001");

    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(63);
    expect(second.length).toBeLessThanOrEqual(63);
    expect(first).toMatch(/^[a-z0-9][a-z0-9_.-]*$/);
    expect(second).toMatch(/^[a-z0-9][a-z0-9_.-]*$/);
  });

  it("stays a legal docker name when the run id contributes nothing readable", () => {
    expect(containerName(config, { ...TEST_JOB, runId: "///" }, "***")).toMatch(/^maestro-[0-9a-f]{12}$/);
  });
});
