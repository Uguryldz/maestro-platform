import { createHash } from "node:crypto";
import type { RunJob } from "@maestro/ports";
import type { DockerRunnerConfig, EgressConfig } from "./config.js";
import { ImageRef, profileIssues } from "./config.js";
import type { ContainerSpec } from "./docker-client.js";
import { RunnerConfigError } from "./errors.js";
import {
  assertCacheKey,
  cacheMountPath,
  cacheVolumeName,
  WORKSPACE_MOUNT_PATH,
  workspaceVolumeName,
} from "./workspace.js";

/**
 * The hardened container profile (M23/M24/M26/M27), as ONE pure function from
 * configuration + job to the Docker create payload. Pure on purpose: the
 * profile is a security control, and a security control that can only be
 * observed by starting a container cannot be unit-tested.
 */

const NANO_CPUS = 1_000_000_000;
const MEGABYTE = 1_024 * 1_024;

/** Proxy variables the platform owns; a job may not override them (M26). */
export const RESERVED_ENV_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
];

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Loaders that turn an environment variable into code execution inside the
 * sandbox before the job's own command runs. They are refused outright: the
 * point of the profile is that the command is what the workflow asked for.
 */
const FORBIDDEN_ENV_NAMES = ["LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "NODE_OPTIONS", "BASH_ENV"];

export interface SandboxInput {
  config: DockerRunnerConfig;
  image: string;
  job: RunJob;
  leaseId: string;
  platform: string;
  cacheKeys: readonly string[];
}

/** `NetworkMode` for the job. No egress configuration means NO network (M26). */
export function egressNetworkMode(egress: EgressConfig): string {
  return egress.networkName ?? "none";
}

const NAME_LIMIT = 63;
const NAME_HASH_LENGTH = 12;

function digest(value: string, length: number): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, length);
}

/**
 * Deterministic, collision-free container name — the audit trail points at it.
 * The readable slug is TRUNCATED to fit Docker's 63 characters, so it cannot
 * carry the identity alone: two long run ids sharing a prefix used to collapse
 * onto one name, and the second `containers/create` answered 409. The hash of
 * the full `runId + leaseId` is what keeps the mapping injective.
 */
export function containerName(config: DockerRunnerConfig, job: RunJob, leaseId: string): string {
  const suffix = digest(`${job.runId}\n${leaseId}`, NAME_HASH_LENGTH);
  const room = NAME_LIMIT - config.labelPrefix.length - suffix.length - 2;
  const slug = `${job.runId}-${leaseId}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, Math.max(room, 0))
    .replace(/-+$/, "");
  return slug.length > 0 ? `${config.labelPrefix}-${slug}-${suffix}` : `${config.labelPrefix}-${suffix}`;
}

/** Name of the one-shot container that hands a fresh volume to the sandbox uid. */
export function prepareContainerName(config: DockerRunnerConfig, volume: string, nonce: string): string {
  return `${config.labelPrefix}-prep-${digest(`${volume}\n${nonce}`, 16)}`;
}

/**
 * Job environment + the platform's egress variables. Fails closed on anything
 * a job should not be able to say; the proxy settings are appended LAST so
 * they are the effective values even if the checks above ever loosen.
 */
export function sandboxEnv(config: DockerRunnerConfig, job: RunJob): string[] {
  const env: string[] = [`HOME=${WORKSPACE_MOUNT_PATH}`, `MAESTRO_RUN_ID=${job.runId}`];
  for (const [name, value] of Object.entries(job.env ?? {})) {
    if (!ENV_NAME.test(name)) throw new RunnerConfigError(`environment variable name "${name}" is not a valid name`);
    if (RESERVED_ENV_NAMES.includes(name)) {
      throw new RunnerConfigError(`environment variable "${name}" is owned by the egress policy (M26)`);
    }
    if (FORBIDDEN_ENV_NAMES.includes(name)) {
      throw new RunnerConfigError(`environment variable "${name}" can inject code into the sandbox — refused`);
    }
    if (value.includes("\0")) throw new RunnerConfigError(`environment variable "${name}" contains a NUL byte`);
    env.push(`${name}=${value}`);
  }
  const { proxyUrl, noProxy } = config.egress;
  if (proxyUrl !== undefined) {
    env.push(`HTTP_PROXY=${proxyUrl}`, `HTTPS_PROXY=${proxyUrl}`, `http_proxy=${proxyUrl}`, `https_proxy=${proxyUrl}`);
    const skip = ["localhost", "127.0.0.1", ...noProxy].join(",");
    env.push(`NO_PROXY=${skip}`, `no_proxy=${skip}`);
  }
  return env;
}

/**
 * Whether ONE dependency cache is writable (M31 layer ①). Read-only is the
 * default because a poisoned cache crosses tickets; `cacheWritableKeys` is the
 * warm-up path — the named keys a build may fill — and it is a list, not a
 * global switch, so opening one cache does not open all of them.
 */
export function cacheIsWritable(config: DockerRunnerConfig, key: string): boolean {
  return !config.workspace.cacheReadOnly || config.workspace.cacheWritableKeys.includes(key);
}

/** Volume binds: workspace (M31 layer ②, rw) + dependency caches (layer ①, ro). */
export function sandboxBinds(config: DockerRunnerConfig, job: RunJob, cacheKeys: readonly string[]): string[] {
  const workspace = workspaceVolumeName(job.workspaceKey, config.workspace.volumePrefix);
  const binds = [`${workspace}:${WORKSPACE_MOUNT_PATH}:rw`];
  for (const key of cacheKeys) {
    assertCacheKey(key);
    const mode = cacheIsWritable(config, key) ? "rw" : "ro";
    binds.push(`${cacheVolumeName(key, config.workspace.cachePrefix)}:${cacheMountPath(key)}:${mode}`);
  }
  return binds;
}

/** Marker file that makes a prepared volume non-empty, so no later mount re-seeds it. */
export const WORKSPACE_OWNER_MARKER = ".maestro-workspace";

/** Memory ceiling for the preparation container — it runs one `chown` and exits. */
const PREPARE_MEMORY_MB = 256;
const PREPARE_PIDS_LIMIT = 32;

/**
 * The one-shot container that hands a freshly created volume to the sandbox
 * uid (M30/M31). An empty `local` volume is born root:root 0755 and the job
 * runs as 10001, so without this step `/workspace` is READ-ONLY to the job —
 * no clone, no build, no Agent SDK session files.
 *
 * It is the only container this package runs as root, and it is built from
 * configuration alone: fixed argv, no job command, no job environment, no
 * network, read-only rootfs, every capability dropped except the two `chown`
 * itself needs. The marker file it writes also keeps Docker from re-seeding
 * (and re-chowning) the volume from the image on the next mount.
 */
export function buildPrepareSpec(
  config: DockerRunnerConfig,
  image: string,
  volume: string,
  mountPath: string,
): ContainerSpec {
  const owner = config.sandbox.user;
  const script = [
    "set -e",
    `mkdir -p ${mountPath}`,
    `printf '%s' '${owner}' > ${mountPath}/${WORKSPACE_OWNER_MARKER}`,
    `chown -R ${owner} ${mountPath}`,
  ].join("; ");
  const memoryBytes = PREPARE_MEMORY_MB * MEGABYTE;
  return {
    Image: image,
    Cmd: ["/bin/sh", "-c", script],
    Entrypoint: [],
    User: "0:0",
    Env: [],
    WorkingDir: "/",
    Tty: false,
    OpenStdin: false,
    AttachStdin: false,
    NetworkDisabled: true,
    Labels: {
      [`${config.labelPrefix}.managed`]: "true",
      [`${config.labelPrefix}.purpose`]: "workspace-prepare",
      [`${config.labelPrefix}.volume`]: volume,
    },
    HostConfig: {
      Binds: [`${volume}:${mountPath}:rw`],
      NetworkMode: "none",
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      CapAdd: ["CHOWN", "FOWNER"],
      SecurityOpt: ["no-new-privileges:true"],
      Privileged: false,
      Init: true,
      Memory: memoryBytes,
      MemorySwap: memoryBytes,
      PidsLimit: PREPARE_PIDS_LIMIT,
      AutoRemove: false,
      RestartPolicy: { Name: "no" },
      ...(config.sandbox.runtime === undefined ? {} : { Runtime: config.sandbox.runtime }),
      LogConfig: { Type: "json-file", Config: { "max-size": "1m", "max-file": "1" } },
    },
  };
}

export function buildContainerSpec(input: SandboxInput): ContainerSpec {
  const { config, job } = input;
  const { sandbox } = config;

  // The gate runs again here, not only in the schema: a profile assembled in
  // code (tests, a future admin API) must not be able to skip it.
  const issues = profileIssues(config);
  if (issues.length > 0) {
    throw new RunnerConfigError(issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  if (!ImageRef.safeParse(input.image).success) {
    throw new RunnerConfigError(`image "${input.image}" is not digest-pinned (M27)`);
  }
  if (job.command.length === 0) throw new RunnerConfigError("job command is empty");

  // `SecurityOpt` has no literal for "the daemon's default seccomp profile":
  // Docker parses any other `seccomp=` value as a profile document and refuses
  // to start (verified against Engine 29.4 — fixtures/containers-start*.http).
  // Saying nothing is therefore what keeps the default filter ON.
  const securityOpt = sandbox.seccomp === "unconfined" ? ["seccomp=unconfined"] : [];
  if (sandbox.noNewPrivileges) securityOpt.unshift("no-new-privileges:true");

  const memoryBytes = sandbox.memoryMb * MEGABYTE;
  const labels: Record<string, string> = {
    [`${config.labelPrefix}.managed`]: "true",
    [`${config.labelPrefix}.run-id`]: job.runId,
    [`${config.labelPrefix}.lease-id`]: input.leaseId,
    [`${config.labelPrefix}.platform`]: input.platform,
    [`${config.labelPrefix}.workspace`]: workspaceVolumeName(job.workspaceKey, config.workspace.volumePrefix),
  };

  return {
    Image: input.image,
    Cmd: [...job.command],
    Entrypoint: [],
    User: sandbox.user,
    Env: sandboxEnv(config, job),
    WorkingDir: WORKSPACE_MOUNT_PATH,
    Tty: false,
    OpenStdin: false,
    AttachStdin: false,
    NetworkDisabled: egressNetworkMode(config.egress) === "none",
    Labels: labels,
    HostConfig: {
      Binds: sandboxBinds(config, job, input.cacheKeys),
      NetworkMode: egressNetworkMode(config.egress),
      ReadonlyRootfs: sandbox.readonlyRootfs,
      CapDrop: ["ALL"],
      CapAdd: [...sandbox.capAdd],
      SecurityOpt: securityOpt,
      Privileged: false,
      Init: true,
      // `size=` keeps a runaway `dd` inside the tmpfs from eating host RAM.
      Tmpfs: { "/tmp": `rw,noexec,nosuid,nodev,size=${sandbox.tmpfsMb}m` },
      Memory: memoryBytes,
      // Equal to `Memory` = swap disabled: a memory limit that can swap is a
      // suggestion, not a limit.
      MemorySwap: memoryBytes,
      NanoCpus: Math.round(sandbox.cpus * NANO_CPUS),
      PidsLimit: sandbox.pidsLimit,
      Ulimits: [{ Name: "nofile", Soft: sandbox.openFilesLimit, Hard: sandbox.openFilesLimit }],
      AutoRemove: false,
      RestartPolicy: { Name: "no" },
      ...(sandbox.runtime === undefined ? {} : { Runtime: sandbox.runtime }),
      LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
    },
  };
}
