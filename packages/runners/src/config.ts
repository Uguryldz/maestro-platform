import { NonEmpty } from "@maestro/contracts";
import { z } from "zod";

/**
 * Runner configuration (M21-M27). Two rules shape this file:
 *
 * 1. **The strictest profile is the DEFAULT.** Every hardening switch defaults
 *    to on, and a config that says nothing gets a container with a read-only
 *    rootfs, no capabilities, no privilege escalation, a non-root uid, hard
 *    mem/cpu/pid limits and NO network at all.
 * 2. **Weakening is explicit and never available in production.** Turning a
 *    switch off requires naming it in `allowUnsafeProfile`, and that escape
 *    hatch is refused outright when the process runs in production (M6).
 */

export const RUNNER_PORT = "RunnerPort";
export const DOCKER_LINUX_DRIVER = "docker-linux";

/** Engine API version the client pins; see `DockerRunnerConfig.apiVersion`. */
export const DEFAULT_API_VERSION = "v1.44";

/** Platforms this driver serves. mac/win are agent-connected runners (M21/M22). */
export const LinuxPlatform = z.enum(["linux-node", "linux-android"]);
export type LinuxPlatform = z.infer<typeof LinuxPlatform>;

/**
 * Digest-pinned image reference (M27). A tag is mutable — `node:22` is a
 * different filesystem tomorrow — so the scan result stapled to an image only
 * means something if the reference is content-addressed. Both
 * `registry/repo@sha256:<64hex>` and a bare local image id are accepted.
 */
export const ImageRef = z
  .string()
  .regex(
    /^(?:(?:[a-z0-9][a-z0-9._-]*(?::\d{1,5})?\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?@)?sha256:[0-9a-f]{64}$/,
    "image must be digest-pinned: 'repo[:tag]@sha256:<64 hex>' or 'sha256:<64 hex>' (M27)",
  );

/** Linux capability names an operator may add back, upper-case as Docker wants. */
const CapName = z.string().regex(/^[A-Z][A-Z0-9_]*$/);

/** The switches whose relaxation must be named one by one. */
export const UnsafeRelaxation = z.enum([
  "readonly-rootfs",
  "no-new-privileges",
  "cap-add",
  "seccomp",
  "direct-egress",
]);
export type UnsafeRelaxation = z.infer<typeof UnsafeRelaxation>;

/**
 * Deployment stage, following `@maestro/secrets`' `resolveStage` rule: the
 * environment may only HARDEN the gate. Exactly two spellings name a
 * non-production stage; unset, empty and unrecognised all mean production.
 *
 * "Unset means development" is the shape of this bug: a container image that
 * never exports `NODE_ENV` would otherwise unlock every relaxation on a
 * production host, silently.
 */
export function isProductionStage(env: NodeJS.ProcessEnv = process.env): boolean {
  const stage = env.NODE_ENV?.trim().toLowerCase();
  if (stage === undefined || stage === "") return true;
  return stage !== "development" && stage !== "test";
}

/**
 * `uid:gid`, decimal, no leading zeros — because Docker resolves the field
 * NUMERICALLY: `00`, `000000` and `0` are all root to the daemon, so a string
 * comparison against "0:" is not a check, it is a suggestion. Zero itself is
 * refused by the gate below (a schema cannot say "in production" but this
 * grammar makes every remaining spelling of a uid unambiguous).
 */
export const SandboxUser = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,6}):(?:0|[1-9]\d{0,6})$/, "user must be 'uid:gid' in plain decimal (M23)");

/** Parsed halves of a validated `uid:gid`. */
export function parseUserIds(user: string): { uid: number; gid: number } | undefined {
  if (!SandboxUser.safeParse(user).success) return undefined;
  const [uid = "", gid = ""] = user.split(":");
  return { uid: Number.parseInt(uid, 10), gid: Number.parseInt(gid, 10) };
}

/**
 * Egress network names. `host`, `none`, `bridge`, `default` and `container:<id>`
 * are not networks the operator built — they are namespace selectors, and
 * `NetworkMode: "host"` hands the job every service listening on the runner
 * host's loopback. The grammar rejects the `container:` form outright (no
 * colon) and the reserved words are named below.
 */
const RESERVED_NETWORK_NAMES = new Set(["host", "none", "bridge", "default"]);

export const EgressNetworkName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/, "egress network must be a plain docker network name (M26)")
  .refine((name) => !RESERVED_NETWORK_NAMES.has(name), {
    message: "host/none/bridge/default are namespace selectors, not audited egress networks (M26)",
  });

export const SandboxProfile = z.object({
  /** M23: the container filesystem is immutable; writes go to the tmpfs + volumes. */
  readonlyRootfs: z.boolean().default(true),
  noNewPrivileges: z.boolean().default(true),
  /** `uid:gid`. Root is refused unconditionally — no escape hatch (M23). */
  user: SandboxUser.default("10001:10001"),
  /** ALL capabilities are dropped first; anything here is added back explicitly. */
  capAdd: z.array(CapName).default([]),
  seccomp: z.enum(["default", "unconfined"]).default("default"),
  memoryMb: z.number().int().min(128).max(131_072).default(2_048),
  cpus: z.number().min(0.25).max(64).default(2),
  pidsLimit: z.number().int().min(16).max(8_192).default(256),
  /** Writable scratch space; noexec/nosuid/nodev are not configurable. */
  tmpfsMb: z.number().int().min(16).max(65_536).default(512),
  openFilesLimit: z.number().int().min(64).max(1_048_576).default(4_096),
  /**
   * M23 stage 3: `runsc` (gVisor). Unset means the daemon default runtime.
   * An allow-list, not free text: the runtime name selects which binary the
   * daemon executes for this container.
   */
  runtime: z.enum(["runc", "runsc"]).optional(),
  allowUnsafeProfile: z.array(UnsafeRelaxation).default([]),
});
export type SandboxProfile = z.infer<typeof SandboxProfile>;

/**
 * Egress (M26): a job reaches the outside world through ONE audited proxy, or
 * not at all. Configuring nothing yields `NetworkMode: none`, which is the
 * safe end of the range — an unreachable registry fails a build loudly, an
 * unmonitored direct route fails an audit silently.
 */
export const EgressConfig = z.object({
  /**
   * Docker network that only routes to the egress proxy. It must exist and be
   * `Internal: true`; the driver verifies that against the daemon before the
   * first container starts (`provision.ts`), because injecting `HTTP_PROXY`
   * only asks the job to use the proxy — an internal network is what stops it
   * from opening a raw socket instead.
   */
  networkName: EgressNetworkName.optional(),
  proxyUrl: z.url().optional(),
  /** Hosts reachable inside the network without the proxy (registry mirror…). */
  noProxy: z.array(NonEmpty).default([]),
});
export type EgressConfig = z.infer<typeof EgressConfig>;

export const WorkspaceConfig = z.object({
  volumePrefix: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).default("maestro-ws"),
  cachePrefix: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).default("maestro-cache"),
  /**
   * M31: the ticket workspace lives on an ENCRYPTED disk. Encryption itself is
   * host provisioning (LUKS/fscrypt), but the volume must be created on it
   * deliberately — hence an explicit driver + options instead of letting a
   * bind auto-create a volume wherever the daemon's default root happens to be.
   */
  volumeDriver: NonEmpty.default("local"),
  volumeOptions: z.record(z.string(), z.string()).default({}),
  /** M65 lifecycle bound; the sweeper uses it, the driver only carries it. */
  maxAgeDays: z.number().int().min(1).max(3_650).default(60),
  /**
   * M31 layer ①: the dependency cache is shared between tickets, so a job may
   * only READ it by default; a poisoned cache would otherwise cross tickets.
   */
  cacheReadOnly: z.boolean().default(true),
  /**
   * The write path a read-only cache would otherwise lack: the keys a WARM-UP
   * job may fill. Named one by one on purpose — a cache nobody can ever write
   * stays empty forever, and a cache everybody can write is a cross-ticket
   * supply chain. Empty by default; the warm-up runner is configured with it.
   */
  cacheWritableKeys: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]*$/)).max(64).default([]),
  /**
   * Whether the driver hands a freshly created volume to the sandbox uid with
   * a one-shot `chown` container (see `buildPrepareSpec`). Turn it off only for
   * images that already ship `/workspace` owned by that uid — it can make a run
   * fail, never escalate, so it is safe to expose.
   */
  prepareOwnership: z.boolean().default(true),
});
export type WorkspaceConfig = z.infer<typeof WorkspaceConfig>;

export const PlatformSlot = z.object({
  image: ImageRef,
  capacity: z.number().int().min(1).max(64).default(1),
});
export type PlatformSlot = z.infer<typeof PlatformSlot>;

export const DockerRunnerConfig = z
  .object({
    /** Pinned Engine API version: an unpinned client silently changes shape. */
    apiVersion: z.string().regex(/^v1\.\d{1,3}$/).default(DEFAULT_API_VERSION),
    socketPath: NonEmpty.default("/var/run/docker.sock"),
    requestTimeoutMs: z.number().int().min(100).max(300_000).default(30_000),
    /** One entry per served platform; an unlisted platform is refused. */
    platforms: z.partialRecord(LinuxPlatform, PlatformSlot),
    sandbox: SandboxProfile.prefault({}),
    egress: EgressConfig.prefault({}),
    workspace: WorkspaceConfig.prefault({}),
    /** Ceiling for `RunJob.timeoutSeconds` (M23) — a larger request is refused. */
    maxTimeoutSeconds: z.number().int().min(1).max(86_400).default(3_600),
    /** How long a killed container may take to die before we stop waiting. */
    killGraceMs: z.number().int().min(100).max(60_000).default(5_000),
    /** Cap on the stdout/stderr tails handed back in `RunResult`. */
    maxTailBytes: z.number().int().min(256).max(1_048_576).default(16_384),
    labelPrefix: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/).default("maestro"),
  })
  .superRefine((config, ctx) => {
    for (const issue of profileIssues(config)) {
      ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
    }
  });
export type DockerRunnerConfig = z.infer<typeof DockerRunnerConfig>;

interface ProfileIssue {
  path: (string | number)[];
  message: string;
}

/**
 * The hardening gate, kept separate from the schema so it is directly testable
 * and so the same rules can be re-checked at container build time.
 */
export function profileIssues(
  config: { sandbox: SandboxProfile; egress: EgressConfig; platforms: Record<string, unknown> },
  env: NodeJS.ProcessEnv = process.env,
): ProfileIssue[] {
  const issues: ProfileIssue[] = [];
  const { sandbox, egress } = config;
  const allowed = new Set(sandbox.allowUnsafeProfile);
  const production = isProductionStage(env);

  if (Object.keys(config.platforms).length === 0) {
    issues.push({ path: ["platforms"], message: "at least one platform must be configured" });
  }

  // Compared as NUMBERS, the way Docker reads the field: "00:0" and "000000:0"
  // are root too, and an unparseable field is refused rather than guessed at.
  const ids = parseUserIds(sandbox.user);
  if (ids === undefined) {
    issues.push({ path: ["sandbox", "user"], message: `user "${sandbox.user}" is not a plain decimal uid:gid (M23)` });
  } else if (ids.uid === 0 || ids.gid === 0) {
    issues.push({
      path: ["sandbox", "user"],
      message: "container uid/gid 0 is never allowed (M23) — use a non-root uid and gid",
    });
  }

  if (egress.networkName !== undefined && !EgressNetworkName.safeParse(egress.networkName).success) {
    issues.push({
      path: ["egress", "networkName"],
      message: `egress network "${egress.networkName}" is not an audited docker network (M26)`,
    });
  }

  const relaxations: { on: boolean; key: UnsafeRelaxation; path: (string | number)[]; what: string }[] = [
    { on: !sandbox.readonlyRootfs, key: "readonly-rootfs", path: ["sandbox", "readonlyRootfs"], what: "a writable rootfs" },
    { on: !sandbox.noNewPrivileges, key: "no-new-privileges", path: ["sandbox", "noNewPrivileges"], what: "privilege escalation" },
    { on: sandbox.capAdd.length > 0, key: "cap-add", path: ["sandbox", "capAdd"], what: "added capabilities" },
    { on: sandbox.seccomp === "unconfined", key: "seccomp", path: ["sandbox", "seccomp"], what: "an unconfined seccomp profile" },
    {
      on: egress.networkName !== undefined && egress.proxyUrl === undefined,
      key: "direct-egress",
      path: ["egress", "proxyUrl"],
      what: "a network without an egress proxy (M26)",
    },
  ];

  for (const relaxation of relaxations) {
    if (!relaxation.on) continue;
    if (production) {
      issues.push({ path: relaxation.path, message: `${relaxation.what} is refused in production (M23/M26)` });
    } else if (!allowed.has(relaxation.key)) {
      issues.push({
        path: relaxation.path,
        message: `${relaxation.what} requires allowUnsafeProfile to list "${relaxation.key}"`,
      });
    }
  }

  return issues;
}
