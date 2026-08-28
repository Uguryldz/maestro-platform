import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PortRegistry, type RunnerPort } from "@maestro/ports";
import { describe, expect, it } from "vitest";
import { DOCKER_LINUX_DRIVER, RUNNER_PORT } from "../src/config.js";
import { DockerLinuxRunner } from "../src/docker-runner.js";
import { RunnerConfigError } from "../src/errors.js";
import * as publicApi from "../src/index.js";
import { createDockerLinuxRunner, registerRunnerDrivers, resolvePinnedImage } from "../src/register.js";
import { dockerRoutes, fakeTransport, httpResponse, TEST_CONFIG } from "./helpers.js";

const deps = () => ({ transport: fakeTransport(dockerRoutes()).transport });

describe("driver registration (M44)", () => {
  it("registers the docker-linux driver on the runner port", () => {
    const registry = new PortRegistry();
    registerRunnerDrivers(registry, deps());

    expect(registry.drivers(RUNNER_PORT)).toEqual([DOCKER_LINUX_DRIVER]);
  });

  it("resolves into a RunnerPort implementation", () => {
    const registry = new PortRegistry();
    registerRunnerDrivers(registry, deps());

    const factory = registry.resolve<RunnerPort>(RUNNER_PORT, DOCKER_LINUX_DRIVER);
    const runner = factory(TEST_CONFIG);

    expect(runner).toBeInstanceOf(DockerLinuxRunner);
    for (const method of ["acquire", "runSession", "mountCache", "release"] as const) {
      expect(typeof runner[method]).toBe("function");
    }
  });

  it("refuses to resolve a driver it does not provide", () => {
    const registry = new PortRegistry();
    registerRunnerDrivers(registry, deps());

    expect(() => registry.resolve(RUNNER_PORT, "agent-windows")).toThrow(/no driver "agent-windows"/);
  });

  it("reports every configuration issue at once, as a RunnerConfigError", () => {
    const error = (() => {
      try {
        createDockerLinuxRunner({ platforms: { "linux-node": { image: "node:22" } }, apiVersion: "1.44" }, deps());
      } catch (thrown) {
        return thrown as Error;
      }
    })();

    expect(error).toBeInstanceOf(RunnerConfigError);
    expect(error?.message).toMatch(/apiVersion/);
    expect(error?.message).toMatch(/image/);
  });

  it("does not open a socket when a transport is injected", () => {
    const transport = fakeTransport(dockerRoutes());

    createDockerLinuxRunner(TEST_CONFIG, { transport: transport.transport });

    expect(transport.requests).toHaveLength(0);
  });
});

describe("image pinning helper (M27)", () => {
  it("prefers a repo digest over the local image id", async () => {
    const transport = fakeTransport(dockerRoutes());

    const pinned = await resolvePinnedImage("postgres:16-alpine", { transport: transport.transport });

    expect(pinned).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(transport.requests[0]?.path).toContain("/images/");
  });

  it("falls back to the content-addressed id when the image has no repo digest", async () => {
    const imageId = `sha256:${"e".repeat(64)}`;
    const transport = fakeTransport(() => httpResponse(200, JSON.stringify({ Id: imageId, RepoDigests: [] })));

    await expect(resolvePinnedImage("local-only", { transport: transport.transport })).resolves.toBe(imageId);
  });
});

describe("public API surface", () => {
  it("does not hand out DockerClient as a value — it would bypass the hardened profile", () => {
    expect(Object.keys(publicApi)).not.toContain("DockerClient");
  });

  it("exports what a composition root needs", () => {
    expect(Object.keys(publicApi)).toEqual(
      expect.arrayContaining([
        "registerRunnerDrivers",
        "createDockerLinuxRunner",
        "resolvePinnedImage",
        "RUNNER_PORT",
        "DOCKER_LINUX_DRIVER",
        "AgentRegistry",
      ]),
    );
  });
});

/**
 * M22 is a direction, not a feature: runners dial OUT to Maestro. A listening
 * socket anywhere in this package would invert that, so the source is checked
 * for one — the cheapest possible guard against it creeping back in.
 */
describe("no inbound ports (M22)", () => {
  const SRC = fileURLToPath(new URL("../src/", import.meta.url));

  it("never creates a server or listens on anything", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(SRC)) {
      const source = readFileSync(`${SRC}${file}`, "utf8");
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      if (/createServer|\.listen\(|node:http\b|WebSocketServer/.test(code)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });

  it("touches the network in exactly one file, through a unix socket", () => {
    const users = readdirSync(SRC).filter((file) => /from "node:net"/.test(readFileSync(`${SRC}${file}`, "utf8")));

    expect(users).toEqual(["unix-transport.ts"]);
    expect(readFileSync(`${SRC}unix-transport.ts`, "utf8")).toContain("connect({ path: socketPath })");
  });
});
