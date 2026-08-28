import type { RunnerLease, RunResult } from "@maestro/ports";
import type { DockerLinuxRunner } from "../src/docker-runner.js";
import { encodeRequest, decodeResponse } from "../src/http.js";
import { createDockerLinuxRunner, resolvePinnedImage } from "../src/register.js";
import { createUnixSocketTransport } from "../src/unix-transport.js";

/**
 * Rig for the OPT-IN escape battery (`MAESTRO_DOCKER_IT=1`).
 *
 * The unit suite proves what the driver SENDS. These tests prove what the
 * daemon then DOES — the gap where "the fixtures were green, production was
 * not" lives, and where every one of this round's findings hid: a spec that
 * says `User: "00:0"` is a container running as root, a spec that says
 * `NetworkMode: "maestro-net"` is raw TCP to the internet if that network is
 * not internal, and a workspace volume the job cannot write is a package that
 * does not do its job at all.
 *
 *   MAESTRO_DOCKER_IT=1 pnpm -F @maestro/runners test
 *
 * The image must already be present locally: the daemon is never asked to pull.
 */

export const IT_ENABLED = process.env["MAESTRO_DOCKER_IT"] === "1";
export const SOCKET = process.env["MAESTRO_DOCKER_IT_SOCKET"] ?? "/var/run/docker.sock";
export const IMAGE = process.env["MAESTRO_DOCKER_IT_IMAGE"] ?? "postgres:16-alpine";

/** Everything this battery creates carries it, so cleanup can find the leftovers. */
export const IT_PREFIX = "maestro-it";

export const transport = createUnixSocketTransport(SOCKET);

let pinned: string | undefined;

export async function itImage(): Promise<string> {
  pinned ??= await resolvePinnedImage(IMAGE, { transport });
  return pinned;
}

/** One raw Engine call, for the few endpoints the narrow production client deliberately lacks. */
export async function daemon(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string }> {
  const request = {
    method,
    path: `/v1.44${path}`,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
  const response = decodeResponse(await transport.exchange(encodeRequest(request), { timeoutMs: 30_000 }));
  return { status: response.status, text: Buffer.from(response.body).toString("utf8") };
}

export async function createNetwork(name: string, internal: boolean): Promise<void> {
  const created = await daemon("POST", "/networks/create", {
    Name: name,
    Driver: "bridge",
    Internal: internal,
    Labels: { [`${IT_PREFIX}.managed`]: "true" },
  });
  if (created.status >= 300) throw new Error(`could not create network ${name}: ${created.text}`);
}

export async function removeNetwork(name: string): Promise<void> {
  await daemon("DELETE", `/networks/${name}`);
}

export interface ItRunner {
  runner: DockerLinuxRunner;
  lease: RunnerLease;
  /** Runs a shell script in the sandbox and returns the raw result. */
  shell(script: string, timeoutSeconds?: number): Promise<RunResult>;
  release(): Promise<void>;
}

let workspaces = 0;

/** One workspace per rig: two tests sharing a volume would fight over its lifetime. */
function nextWorkspaceKey(): string {
  workspaces += 1;
  return `${IT_PREFIX}/ws-${process.pid}-${workspaces}`;
}

/** A leased runner with the hardened defaults, plus whatever the test overrides. */
export async function itRunner(config: Record<string, unknown> = {}, workspaceKey = nextWorkspaceKey()): Promise<ItRunner> {
  const image = await itImage();
  const runner = createDockerLinuxRunner(
    {
      platforms: { "linux-node": { image, capacity: 1 } },
      requestTimeoutMs: 60_000,
      labelPrefix: IT_PREFIX,
      sandbox: { memoryMb: 256, cpus: 1, pidsLimit: 64 },
      ...config,
    },
    { transport },
  );
  const lease = await runner.acquire("linux-node");
  let runs = 0;
  return {
    runner,
    lease,
    shell: (script, timeoutSeconds = 90) => {
      runs += 1;
      return runner.runSession(lease, {
        runId: `${IT_PREFIX}-${Date.now()}-${runs}`,
        workspaceKey,
        command: ["/bin/sh", "-c", script],
        timeoutSeconds,
      });
    },
    release: async () => {
      await runner.release(lease);
      await runner.removeWorkspace(workspaceKey, "integration-test");
    },
  };
}

/** Names of every object this battery labelled — the leak check at the end of a file. */
export async function leftovers(): Promise<{ containers: string[]; volumes: string[]; networks: string[] }> {
  const filters = encodeURIComponent(JSON.stringify({ label: [`${IT_PREFIX}.managed=true`] }));
  const containers = await daemon("GET", `/containers/json?all=1&filters=${filters}`);
  const volumes = await daemon("GET", `/volumes?filters=${filters}`);
  const networks = await daemon("GET", `/networks?filters=${filters}`);
  const parsedContainers = JSON.parse(containers.text) as { Names: string[] }[];
  const parsedVolumes = (JSON.parse(volumes.text) as { Volumes: { Name: string }[] | null }).Volumes ?? [];
  const parsedNetworks = JSON.parse(networks.text) as { Name: string }[];
  return {
    containers: parsedContainers.flatMap((container) => container.Names),
    volumes: parsedVolumes.map((volume) => volume.Name),
    networks: parsedNetworks.map((network) => network.Name),
  };
}
