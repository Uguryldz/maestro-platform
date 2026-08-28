import type { RunJob } from "@maestro/ports";
import type { DockerRunnerConfig, LinuxPlatform } from "./config.js";
import type { DockerClient } from "./docker-client.js";
import type { AuditSink, Clock, IdSource } from "./deps.js";
import { RUNNER_ACTOR } from "./deps.js";
import { RunnerConfigError } from "./errors.js";
import { buildContainerSpec, buildPrepareSpec, containerName, prepareContainerName } from "./sandbox.js";
import {
  expiredWorkspaces,
  WORKSPACE_MOUNT_PATH,
  type WorkspaceRecord,
  workspaceVolumeName,
} from "./workspace.js";

/**
 * The two preconditions a container spec cannot state, because they are facts
 * about the DAEMON rather than about the payload:
 *
 * 1. **Egress (M26).** `HTTP_PROXY` is a request, not a control: a job that
 *    opens a raw socket never reads it. What actually confines the job is the
 *    network, so the driver refuses to run unless the configured network exists
 *    and is `Internal: true` — fail-closed, verified once against the daemon.
 * 2. **Workspace ownership (M30/M31).** A fresh `local` volume is root:root
 *    0755 while the container runs as a non-root uid, so `/workspace` would be
 *    read-only to the job. A one-shot root container hands it over before the
 *    job starts; see `buildPrepareSpec` for why that container is safe.
 */

/** How long the preparation container may take before we stop waiting for it. */
const PREPARE_TIMEOUT_MS = 120_000;

/** What one M65 sweep actually did — per workspace, not "it threw or it did not". */
export interface SweepReport {
  swept: string[];
  /** Expired records whose volume was already gone: nothing removed, nothing archived. */
  missing: string[];
  failed: { workspaceKey: string; reason: string }[];
}

export interface ProvisionerDeps {
  client: DockerClient;
  config: DockerRunnerConfig;
  clock: Clock;
  newId: IdSource;
  audit: AuditSink;
}

export interface SessionContainerRequest {
  job: RunJob;
  leaseId: string;
  platform: LinuxPlatform;
  cacheKeys: readonly string[];
}

export interface VolumeRequest {
  name: string;
  labels: Record<string, string>;
  /** Image the preparation container runs (the platform's pinned image). */
  image: string;
  /** Where the preparation container mounts the volume. */
  mountPath: string;
  /** False for a read-only mount: nothing writes to it, so nothing must own it. */
  writable: boolean;
}

export class SandboxProvisioner {
  readonly #deps: ProvisionerDeps;
  #network: Promise<void> | undefined;

  constructor(deps: ProvisionerDeps) {
    this.#deps = deps;
  }

  /**
   * Everything one session needs BEFORE its container may start: the egress
   * check, the owned workspace volume, the container itself, and the audit
   * record of what was built. Started by the caller, so the driver keeps the
   * `finally` that guarantees removal.
   */
  async createSessionContainer(request: SessionContainerRequest): Promise<{ containerId: string; name: string }> {
    const image = this.#deps.config.platforms[request.platform]?.image;
    if (image === undefined) throw new RunnerConfigError(`platform "${request.platform}" has no image configured`);
    // Fail-closed BEFORE anything is created: an unverified egress network is
    // the difference between "the job talks through the audited proxy" and
    // "the job opens a socket to wherever it likes" (M26).
    await this.verifyEgressNetwork();
    const labelPrefix = this.#deps.config.labelPrefix;
    const name = containerName(this.#deps.config, request.job, request.leaseId);
    const workspaceVolume = workspaceVolumeName(request.job.workspaceKey, this.#deps.config.workspace.volumePrefix);
    // Created explicitly rather than left to the bind's auto-creation, so it
    // lands on the configured (encrypted, M31) volume driver, carries the
    // labels the M65 sweeper needs — and is OWNED by the sandbox uid, or the
    // job cannot clone, build or write its Agent SDK session (M30).
    await this.ensureVolume({
      name: workspaceVolume,
      labels: {
        [`${labelPrefix}.workspace-key`]: request.job.workspaceKey,
        [`${labelPrefix}.layer`]: "workspace",
      },
      image,
      mountPath: WORKSPACE_MOUNT_PATH,
      writable: true,
    });
    const spec = buildContainerSpec({
      config: this.#deps.config,
      image,
      job: request.job,
      leaseId: request.leaseId,
      platform: request.platform,
      cacheKeys: request.cacheKeys,
    });
    const containerId = await this.#deps.client.createContainer(name, spec);
    this.#record("SANDBOX_CREATE", name, {
      runId: request.job.runId,
      platform: request.platform,
      image,
      networkMode: (spec["HostConfig"] as { NetworkMode: string }).NetworkMode,
      workspaceVolume,
      cacheKeys: [...request.cacheKeys],
    });
    return { containerId, name };
  }

  /**
   * M26. Memoised on SUCCESS only — a failed check must be retried, because the
   * operator fixing the network should not have to restart the runner service,
   * while a passing one must not cost a daemon round trip per session.
   */
  async verifyEgressNetwork(): Promise<void> {
    const name = this.#deps.config.egress.networkName;
    if (name === undefined) return;
    const pending = (this.#network ??= this.#checkNetwork(name));
    try {
      await pending;
    } catch (error) {
      this.#network = undefined;
      throw error;
    }
  }

  async #checkNetwork(name: string): Promise<void> {
    const network = await this.#deps.client.inspectNetwork(name);
    if (network === undefined) {
      throw new RunnerConfigError(`egress network "${name}" does not exist on this daemon (M26)`);
    }
    // The daemon also resolves id prefixes, so "maestro-egr" could answer for
    // "maestro-egress" — and the network we verified would not be the one the
    // container joins by name.
    if (network.name !== name) {
      throw new RunnerConfigError(`egress network "${name}" resolved to "${network.name}" — use the exact name (M26)`);
    }
    if (!network.internal) {
      throw new RunnerConfigError(
        `egress network "${name}" is not internal: a job on it can open a raw socket to anywhere and never touch the proxy (M26)`,
      );
    }
  }

  /**
   * Creates the volume if it is missing and makes sure the sandbox uid owns it.
   * The owner is stamped as a label at creation time, so the next session skips
   * the work; a volume labelled for a DIFFERENT uid is prepared again.
   */
  async ensureVolume(request: VolumeRequest): Promise<boolean> {
    const { config, client } = this.#deps;
    const owner = config.sandbox.user;
    const existing = await client.inspectVolume(request.name);
    if (existing === undefined) {
      await client.createVolume(
        request.name,
        {
          [`${config.labelPrefix}.managed`]: "true",
          ...(request.writable ? { [`${config.labelPrefix}.owner`]: owner } : {}),
          ...request.labels,
        },
        config.workspace.volumeDriver,
        config.workspace.volumeOptions,
      );
    } else if (!request.writable || existing.labels[`${config.labelPrefix}.owner`] === owner) {
      return false;
    }
    if (!request.writable || !config.workspace.prepareOwnership) return false;
    await this.#prepare(request, owner);
    return true;
  }

  /**
   * Audited workspace removal (M31 layer ② / M65). Only a volume that WAS there
   * is archived: an audit chain that says "deleted" about a workspace which
   * never existed — twice, after a retry — is a chain telling the auditor a
   * story it cannot back up.
   */
  async removeWorkspace(workspaceKey: string, reason: string): Promise<boolean> {
    const { config, client } = this.#deps;
    const volume = workspaceVolumeName(workspaceKey, config.workspace.volumePrefix);
    // Asked BEFORE the delete: `DELETE /volumes/{name}?force=true` answers 204
    // for a volume that was never there (verified against Engine 29.4), so the
    // delete alone cannot tell "removed" from "there was nothing to remove".
    if ((await client.inspectVolume(volume)) === undefined) return false;
    const removed = await client.removeVolume(volume, true);
    if (removed) this.#record("RETENTION_ARCHIVE", volume, { workspaceKey, reason });
    return removed;
  }

  /**
   * M65 sweep. One failing volume must not end the run — the records behind it
   * would silently never be looked at again — so every record is attempted and
   * the failures are REPORTED instead of thrown.
   */
  async sweepExpiredWorkspaces(records: readonly WorkspaceRecord[]): Promise<SweepReport> {
    const { clock, config } = this.#deps;
    const expired = expiredWorkspaces(records, clock(), config.workspace.maxAgeDays);
    const report: SweepReport = { swept: [], missing: [], failed: [] };
    for (const record of expired) {
      try {
        const removed = await this.removeWorkspace(record.workspaceKey, "workspace-max-age");
        (removed ? report.swept : report.missing).push(record.workspaceKey);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown";
        report.failed.push({ workspaceKey: record.workspaceKey, reason });
      }
    }
    return report;
  }

  /** Runs the fixed `chown` container and refuses the job if it did not succeed. */
  async #prepare(request: VolumeRequest, owner: string): Promise<void> {
    const { client, config } = this.#deps;
    const name = prepareContainerName(config, request.name, this.#deps.newId());
    const spec = buildPrepareSpec(config, request.image, request.name, request.mountPath);
    let containerId: string | undefined;
    try {
      containerId = await client.createContainer(name, spec);
      this.#record("SANDBOX_CREATE", name, { purpose: "workspace-prepare", volume: request.name, owner });
      await client.startContainer(containerId);
      const exitCode = await client.waitContainer(containerId, PREPARE_TIMEOUT_MS);
      this.#record("SANDBOX_DESTROY", name, { purpose: "workspace-prepare", volume: request.name, exitCode });
      if (exitCode !== 0) {
        throw new RunnerConfigError(
          `could not hand workspace volume "${request.name}" to ${owner}: the preparation container exited ${exitCode}. ` +
            `The image must provide /bin/sh and chown, or ship ${request.mountPath} already owned by ${owner} ` +
            "(then set workspace.prepareOwnership=false)",
        );
      }
    } finally {
      if (containerId !== undefined) {
        await client.removeContainer(containerId).catch((error: unknown) => {
          this.#record("SANDBOX_DESTROY", name, {
            purpose: "workspace-prepare",
            removeFailed: true,
            reason: error instanceof Error ? error.name : "unknown",
          });
        });
      }
    }
  }

  #record(
    action: "SANDBOX_CREATE" | "SANDBOX_DESTROY" | "RETENTION_ARCHIVE",
    subject: string,
    meta: Record<string, unknown>,
  ): void {
    this.#deps.audit({ action, actor: RUNNER_ACTOR, subject, at: this.#deps.clock().toISOString(), meta });
  }
}
