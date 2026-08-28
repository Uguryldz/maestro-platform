import { describe, expect, it } from "vitest";
import type { AuditRecord } from "../src/deps.js";
import type { DockerLinuxRunner } from "../src/docker-runner.js";
import { RunnerConfigError } from "../src/errors.js";
import { createDockerLinuxRunner } from "../src/register.js";
import {
  dockerRoutes,
  fakeClock,
  fakeTransport,
  FIXTURES,
  type Handler,
  httpResponse,
  manualTimer,
  sequentialIds,
  TEST_CONFIG,
  TEST_JOB,
} from "./helpers.js";

/**
 * Two controls that a spec assertion cannot see, because they are facts about
 * the DAEMON, not about the payload we send it:
 *
 * 1. M26 egress. Injecting `HTTP_PROXY` only ASKS a job to use the proxy; a job
 *    that opens a raw socket never reads the variable. The control is the
 *    network itself, so the driver refuses to start unless the configured
 *    network exists and is `Internal: true`.
 * 2. M30/M31 workspace. An empty `local` volume is born root:root 0755 and the
 *    container runs as 10001 — so the workspace the whole package exists to
 *    provide is read-only to the job unless somebody hands it over first.
 */

interface Rig {
  runner: DockerLinuxRunner;
  requests: ReturnType<typeof fakeTransport>["requests"];
  matching: ReturnType<typeof fakeTransport>["matching"];
  audit: AuditRecord[];
}

function rig(overrides: Partial<Record<string, Handler>> = {}, config: object = TEST_CONFIG): Rig {
  const transport = fakeTransport(dockerRoutes(overrides));
  const audit: AuditRecord[] = [];
  const runner = createDockerLinuxRunner(config, {
    transport: transport.transport,
    clock: fakeClock().clock,
    timer: manualTimer().timer,
    newId: sequentialIds(),
    audit: (record) => audit.push(record),
  });
  return { runner, requests: transport.requests, matching: transport.matching, audit };
}

function specs(rigged: Rig): Record<string, unknown>[] {
  return rigged.matching("/containers/create").map((request) => JSON.parse(request.body ?? "{}") as Record<string, unknown>);
}

describe("egress is enforced by the network, not by an environment variable (M26)", () => {
  it("verifies the configured network is internal before any container exists", async () => {
    const rigged = rig();
    const lease = await rigged.runner.acquire("linux-node");

    await rigged.runner.runSession(lease, TEST_JOB);

    const inspected = rigged.matching("/networks/");
    expect(inspected).toHaveLength(1);
    expect(inspected[0]?.method).toBe("GET");
    expect(inspected[0]?.path).toContain("/networks/maestro-egress");
    // Before, not after: nothing may run on an unverified network.
    expect(rigged.requests.indexOf(inspected[0]!)).toBe(0);
  });

  it("refuses to run on a network that is not internal — raw TCP would bypass the proxy", async () => {
    const rigged = rig({ "/networks/": () => FIXTURES.networkOpen() }, {
      ...TEST_CONFIG,
      egress: { networkName: "maestro-open", proxyUrl: "http://egress.internal.bank:3128" },
    });
    const lease = await rigged.runner.acquire("linux-node");

    await expect(rigged.runner.runSession(lease, TEST_JOB)).rejects.toThrow(/internal/i);
    expect(rigged.matching("/containers/create")).toHaveLength(0);
  });

  it("refuses to run when the configured network does not exist", async () => {
    const rigged = rig({ "/networks/": () => FIXTURES.networkNotFound() });
    const lease = await rigged.runner.acquire("linux-node");

    await expect(rigged.runner.runSession(lease, TEST_JOB)).rejects.toThrow(RunnerConfigError);
    expect(rigged.matching("/containers/create")).toHaveLength(0);
  });

  it("refuses a network whose real name only starts with the configured one (docker matches prefixes)", async () => {
    const rigged = rig({}, {
      ...TEST_CONFIG,
      egress: { networkName: "maestro-egr", proxyUrl: "http://egress.internal.bank:3128" },
    });
    const lease = await rigged.runner.acquire("linux-node");

    await expect(rigged.runner.runSession(lease, TEST_JOB)).rejects.toThrow(/maestro-egr/);
  });

  it("asks the daemon once, not once per session", async () => {
    const rigged = rig();
    const lease = await rigged.runner.acquire("linux-node");

    await rigged.runner.runSession(lease, TEST_JOB);
    await rigged.runner.runSession(lease, TEST_JOB);

    expect(rigged.matching("/networks/")).toHaveLength(1);
  });

  it("asks for no network at all when egress is unconfigured", async () => {
    const rigged = rig({}, { platforms: TEST_CONFIG.platforms });
    const lease = await rigged.runner.acquire("linux-node");

    await rigged.runner.runSession(lease, TEST_JOB);

    expect(rigged.matching("/networks/")).toHaveLength(0);
    expect(specs(rigged).at(-1)?.["NetworkDisabled"]).toBe(true);
  });
});

describe("the workspace is handed to the sandbox uid before the job runs (M30/M31)", () => {
  it("prepares a freshly created volume with a root-only, network-less init container", async () => {
    const rigged = rig();
    const lease = await rigged.runner.acquire("linux-node");

    await rigged.runner.runSession(lease, TEST_JOB);

    const created = JSON.parse(rigged.matching("/volumes/create")[0]?.body ?? "{}") as { Name: string };
    const [prepare] = specs(rigged);
    expect(rigged.matching("/containers/create")[0]?.path).toContain("-prep-");
    expect(prepare).toMatchObject({ Image: TEST_CONFIG.platforms["linux-node"].image, User: "0:0" });
    expect(JSON.stringify(prepare?.["Cmd"])).toContain("chown -R 10001:10001 /workspace");
    expect(prepare?.["HostConfig"]).toMatchObject({
      Binds: [`${created.Name}:/workspace:rw`],
      NetworkMode: "none",
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      CapAdd: ["CHOWN", "FOWNER"],
      SecurityOpt: ["no-new-privileges:true"],
      Privileged: false,
    });
    expect(prepare?.["NetworkDisabled"]).toBe(true);
  });

  it("runs the preparation to completion and removes it before the job starts", async () => {
    const rigged = rig();
    const lease = await rigged.runner.acquire("linux-node");

    await rigged.runner.runSession(lease, TEST_JOB);

    const order = rigged.requests.map((request) => `${request.method} ${request.path.split("?")[0]}`);
    const firstCreate = order.indexOf("POST /v1.44/containers/create");
    const lastCreate = order.lastIndexOf("POST /v1.44/containers/create");
    const removes = order.map((entry, index) => ({ entry, index })).filter((step) => step.entry.startsWith("DELETE /v1.44/containers/"));
    expect(lastCreate).toBeGreaterThan(firstCreate);
    expect(removes[0]?.index).toBeLessThan(lastCreate);
    expect(removes).toHaveLength(2);
  });

  it("does not prepare a volume that already belongs to the sandbox uid", async () => {
    const rigged = rig({ "GET /volumes/": () => FIXTURES.volumeInspect() });
    const lease = await rigged.runner.acquire("linux-node");

    await rigged.runner.runSession(lease, TEST_JOB);

    expect(rigged.matching("/volumes/create")).toHaveLength(0);
    expect(rigged.matching("/containers/create")).toHaveLength(1);
  });

  it("prepares again when the existing volume belongs to a different uid", async () => {
    const stale = httpResponse(200, JSON.stringify({ Name: "x", Labels: { "maestro.owner": "20002:20002" } }));
    const rigged = rig({ "GET /volumes/": () => stale });
    const lease = await rigged.runner.acquire("linux-node");

    await rigged.runner.runSession(lease, TEST_JOB);

    expect(rigged.matching("/containers/create")).toHaveLength(2);
  });

  it("stamps the owner on the volume it creates, so the next run can skip the work", async () => {
    const rigged = rig();
    const lease = await rigged.runner.acquire("linux-node");

    await rigged.runner.runSession(lease, TEST_JOB);
    const created = JSON.parse(rigged.matching("/volumes/create")[0]?.body ?? "{}") as { Labels: Record<string, string> };

    expect(created.Labels).toMatchObject({ "maestro.owner": "10001:10001", "maestro.layer": "workspace" });
  });

  it("refuses to run the job when the preparation fails — an unwritable workspace is not a job failure", async () => {
    let prepared = false;
    const rigged = rig({
      "/wait": () => {
        if (prepared) return FIXTURES.wait();
        prepared = true;
        return httpResponse(200, JSON.stringify({ StatusCode: 1 }));
      },
    });
    const lease = await rigged.runner.acquire("linux-node");

    await expect(rigged.runner.runSession(lease, TEST_JOB)).rejects.toThrow(/workspace/i);
    expect(rigged.matching("/containers/create")).toHaveLength(1);
  });

  it("removes the preparation container even when it failed", async () => {
    const rigged = rig({ "/wait": () => httpResponse(200, JSON.stringify({ StatusCode: 1 })) });
    const lease = await rigged.runner.acquire("linux-node");

    await expect(rigged.runner.runSession(lease, TEST_JOB)).rejects.toThrow(RunnerConfigError);
    expect(rigged.matching("/containers/").filter((request) => request.method === "DELETE")).toHaveLength(1);
  });

  it("audits the preparation as its own sandbox, distinguishable from the job", async () => {
    const rigged = rig();
    const lease = await rigged.runner.acquire("linux-node");

    await rigged.runner.runSession(lease, TEST_JOB);

    const prepare = rigged.audit.filter((record) => record.meta["purpose"] === "workspace-prepare");
    expect(prepare.map((record) => record.action)).toEqual(["SANDBOX_CREATE", "SANDBOX_DESTROY"]);
    expect(prepare[0]?.meta).toMatchObject({ owner: "10001:10001" });
  });
});

describe("the dependency cache has a defined write path (M31 layer ①)", () => {
  const cacheKey = "dep-linux-node-npm-abc123abc123";

  it("mounts caches read-only by default and never prepares them", async () => {
    const rigged = rig();
    const lease = await rigged.runner.acquire("linux-node");

    await rigged.runner.mountCache(lease, [cacheKey]);
    await rigged.runner.runSession(lease, TEST_JOB);

    const job = specs(rigged).at(-1) as { HostConfig: { Binds: string[] } };
    expect(job.HostConfig.Binds[1]).toMatch(/:\/cache\/dep-linux-node-npm-abc123abc123:ro$/);
    // One preparation only: the workspace. A read-only cache needs no owner.
    expect(rigged.matching("/containers/create")).toHaveLength(2);
  });

  it("mounts a named warm-up key read-write, and hands it to the sandbox uid", async () => {
    const rigged = rig({}, { ...TEST_CONFIG, workspace: { cacheWritableKeys: [cacheKey] } });
    const lease = await rigged.runner.acquire("linux-node");

    await rigged.runner.mountCache(lease, [cacheKey]);
    await rigged.runner.runSession(lease, TEST_JOB);

    const job = specs(rigged).at(-1) as { HostConfig: { Binds: string[] } };
    expect(job.HostConfig.Binds[1]).toMatch(/:\/cache\/dep-linux-node-npm-abc123abc123:rw$/);
    expect(rigged.matching("/containers/create")).toHaveLength(3);
  });
});
