import { createDb, type Db } from "@maestro/db";
import { defaultPiiPolicy } from "@maestro/pii";
import type { LlmPort, StoragePort } from "@maestro/ports";
import { createDockerLinuxRunner } from "@maestro/runners";
import { MAESTRO_TASK_QUEUE, startMaestroWorker, type CoreDeps } from "@maestro/workflows";
import { bootPlatform, degradedCapabilities, MISSING_CORE_DEPS } from "../boot.js";
import { roleResolver } from "../stores/gate-directory.js";
import type { DeployEnv } from "../env.js";
import { docAttacherFor } from "../stores/doc-attacher.js";
import { statusMoverFor } from "../stores/status-mover.js";
import { buildAgentTurnRunner, unrunnableTurnRunner } from "../stores/execution.js";
import { reconcileRunStatuses } from "../stores/reconcile.js";
import { healthPortOf, startWorkerLiveness } from "../worker-liveness.js";
import { prismaSqlExecutor, prismaTransactionRunner } from "../stores/sql.js";
import { llmCallRecorder } from "../stores/llm-call-log.js";
import { connectionModelFrom } from "../stores/connection-model.js";
import { tlsSkipFlagFrom } from "../stores/connection-tls.js";
import { connectionSecretsFrom } from "../stores/connection-secrets.js";
import { buildWorkerCore } from "../stores/worker-core.js";
import { connectTemporal } from "../temporal-gateway.js";
import { fail, isEntrypoint } from "./lifecycle.js";

/**
 * The Temporal worker process.
 *
 * Through wave 4 this entrypoint composed the ports and then refused to poll:
 * the activities need run-scoped state, and nothing implemented it. Starting
 * anyway would have meant a worker that takes tickets and loses every run's
 * context on the first restart — silently, with a Jira comment already posted.
 *
 * Dalga 5 built those stores (`src/stores/`, all Postgres-backed), so the
 * refusal is gone and this process polls for real. `MISSING_CORE_DEPS` stays
 * as the precondition: if a future dependency arrives half-built it goes in
 * that list, and the worker refuses again — at start-up, in front of an
 * operator, rather than mid-ticket.
 */
export async function main(): Promise<void> {
  // The dev profile stores blobs in Postgres, so the database is a dependency
  // of composing the ports — not just of running them.
  const url = process.env["DATABASE_URL"];
  if (url === undefined) {
    throw new Error("DATABASE_URL: required — the worker's storage port writes through it (M6)");
  }
  const address = process.env["TEMPORAL_ADDRESS"];
  if (address === undefined) {
    throw new Error("TEMPORAL_ADDRESS: required — the worker polls the task queue through it");
  }

  const db = createDb(url);

  try {
    /**
     * Built BEFORE the ports: `publish`'s deps need the run context store and
     * the receipt store, and `bootPlatform` wires them into the port at
     * registration time (see `buildPublishDeps`).
     *
     * The turn runner is the one member that cannot be built here — it needs
     * the `llm` and `storage` PORTS, which only exist after `bootPlatform`.
     * So the core is assembled with a placeholder and the real runner is
     * dropped in below, once both halves exist. The alternative orderings both
     * fail: building the ports first breaks `publish`, and making the runner
     * lazy would turn a wiring mistake into a null dereference at the first
     * engineering turn — which is the failure mode `boot.ts` exists to prevent.
     */
    const { core, publishRunDeps } = buildWorkerCore(db, {
      sql: prismaSqlExecutor(db),
      transactions: prismaTransactionRunner(db),
      execution: unrunnableTurnRunner(),
      // Both processes must name the gate's owner group identically: the BFF
      // verifies membership against it, the worker writes it onto the gate and
      // checks the decision's claim against it. Read straight from the raw
      // environment because the stores are built before `bootPlatform`.
      resolveRole: roleResolver(process.env),
    });

    const { env, deployment } = await bootPlatform({
      sql: prismaSqlExecutor(db),
      publishRunDeps,
      // The worker is where model calls happen, so it is where they are
      // recorded. Without this the cost and PII screens answer 200 with an
      // empty table on a deployment that has been spending all day.
      onLlmCall: llmCallRecorder(db.llmCall),
      // The credential a RUN authenticates with now comes from the panel's
      // managed connection when there is one, falling back to the environment.
      // The worker is the process that matters most here: it is where the Jira
      // and GitHub calls of an actual run are made, so a token entered in
      // "Ayarlar & bağlantılar" was previously stored, tested and then ignored
      // by every one of them.
      connectionSecrets: connectionSecretsFrom(db),
      // The model itself, from the same panel rows the credential comes from.
      // Both processes resolve it through this one factory so the endpoint an
      // admin tests green in the panel is the one the run dials — the split
      // `connectionSecrets` closed for the token, closed here for the address.
      resolveModel: connectionModelFrom(db),
      // The handshake, from the same panel rows again: a connection whose
      // admin flagged "TLS doğrulamasını atla" is dialled without certificate
      // verification by every adapter — the run performs the exact handshake
      // the panel's green test did.
      tlsSkipFlag: tlsSkipFlagFrom(db),
    });

    const execution = buildTurnRunner(env, db, deployment.ports);
    /**
     * M103r: the analysis Word/PDF go onto the ticket, if this deployment's
     * work driver can carry a file. `undefined` on Data Center — the documents
     * are then generated and stored, and the journal says they did not land on
     * the ticket. See `stores/doc-attacher.ts` for why the check is structural.
     */
    const docAttacher = docAttacherFor(deployment.ports.work);
    /**
     * The listening rule's status map, made real: the ticket actually moves
     * desk to desk on the operator's board. `undefined` on Data Center, where
     * the driver cannot transition — the flow then narrates in comments as it
     * always has, and the journal says the move was skipped for want of the
     * capability. See `stores/status-mover.ts` for why the check is structural.
     */
    const statusMover = statusMoverFor(deployment.ports.work);
    const workerCore: CoreDeps = {
      ...core,
      execution: execution.runner,
      ...(docAttacher === undefined ? {} : { docAttacher }),
      ...(statusMover === undefined ? {} : { statusMover }),
    };

    if (MISSING_CORE_DEPS.length > 0) {
      throw new Error(
        "worker: the ports compose, but a run-scoped dependency is missing, so the worker " +
          "refuses to poll rather than accept tickets it would lose on restart (M33). Missing:\n  - " +
          MISSING_CORE_DEPS.join("\n  - "),
      );
    }

    const taskQueue = env.TEMPORAL_TASK_QUEUE ?? MAESTRO_TASK_QUEUE;
    console.info(
      `[maestro] worker: composed ${Object.keys(deployment.selection).length} ports on profile ` +
        `${env.profile}, polling ${taskQueue}`,
    );

    /**
     * Printed AFTER the "polling" line, at warn level, on purpose.
     *
     * "The worker started" and "the worker can finish a run" are different
     * claims, and only the first one is proved by getting this far. An
     * operator who sees the success line and nothing else will reasonably
     * assume the second. This says otherwise, in the same place they are
     * already looking.
     */
    const degraded = degradedCapabilities(execution.degradedReason);
    if (degraded.length > 0) {
      console.warn(
        `[maestro] worker: RUNNING WITH ${degraded.length} DEGRADED CAPABILIT` +
          `${degraded.length === 1 ? "Y" : "IES"} — it polls, but a run that reaches ` +
          "one of these stops there with a named error:\n  - " +
          degraded.join("\n  - "),
      );
    }

    await reconcileOnBoot({
      address,
      namespace: env.TEMPORAL_NAMESPACE,
      runs: db.workflowRun,
      audit: workerCore.audit,
    });

    /**
     * The container's answer to "can this worker still take an analysis?".
     *
     * `restart: unless-stopped` only reacts to the process dying, and the
     * failure that actually strands an install is the opposite one: the worker
     * alive but no longer polling. See `worker-liveness.ts`.
     */
    const healthPort = healthPortOf(process.env);
    const liveness = healthPort === null ? null : startWorkerLiveness({ port: healthPort });
    if (healthPort !== null) {
      console.info(`[maestro] worker: sağlık ucu açık — :${healthPort}/healthz`);
    }

    try {
      await startMaestroWorker({
        address,
        taskQueue,
        registry: deployment.registry,
        ports: deployment.selection,
        core: workerCore,
        /**
         * READY means the Temporal worker is RUNNING — actually polling the
         * queue — and nothing weaker.
         *
         * Reporting ready before `startMaestroWorker` would have proved only
         * that the process reached this line, which is exactly the thing that
         * stays true while a worker is wedged. That would have made the probe
         * agree with the failure it exists to catch.
         */
        onState: (state) => liveness?.setReady(state === "RUNNING"),
      });
    } finally {
      // Reported unready BEFORE the process winds down, so a drain in progress
      // is never mistaken for a healthy worker by an in-flight probe.
      liveness?.setReady(false);
      await liveness?.close();
    }
  } finally {
    await db.$disconnect();
  }
}

/**
 * Bring `WorkflowRun.status` back in step with the engine, once, at boot.
 *
 * A run that exhausts its retries dies inside an activity, so no workflow code
 * runs afterwards and the row it started stays `running` forever. Measured on
 * the pilot: 16 of 16 rows said `running` while Temporal held 11 `Failed` and
 * one `Completed`. The dashboard read the rows and reported dead work as live.
 *
 * Boot is the right moment because it is the one instant this process knows
 * the engine's verdict is settled for everything that ran BEFORE it: whatever
 * the previous worker was doing when it died is now closed, and this pass is
 * what writes it down. Runs that fail while this worker is up are a separate
 * problem — see the note in `reconcile.ts` — and this deliberately does not
 * pretend to solve them.
 *
 * NEVER fatal. A worker that cannot reconcile is a worker with a stale
 * dashboard; a worker that refuses to start is a bank with no delivery at all.
 * The failure is loud and the polling continues.
 */
async function reconcileOnBoot(options: {
  address: string;
  namespace: string;
  runs: Parameters<typeof reconcileRunStatuses>[0]["runs"];
  audit: Parameters<typeof reconcileRunStatuses>[0]["audit"];
}): Promise<void> {
  let temporal: Awaited<ReturnType<typeof connectTemporal>> | null = null;
  try {
    temporal = await connectTemporal({
      address: options.address,
      namespace: options.namespace,
    });
    const report = await reconcileRunStatuses({
      runs: options.runs,
      source: temporal.gateway,
      audit: options.audit,
    });
    if (report.reconciled > 0 || report.unknown > 0) {
      console.info(
        `[maestro] worker: reconciled ${report.reconciled} run row(s) against the engine — ` +
          `${report.stillRunning} still running, ${report.unknown} left untouched because the ` +
          "engine has no execution for them (left `running` on purpose: an unknown run is not a " +
          "finished one, and marking it done would hide any gate still waiting on it)",
      );
    }
  } catch (error) {
    console.warn(
      "[maestro] worker: run-status reconciliation FAILED — the worker polls anyway, but until " +
        "the next boot the dashboard may show finished runs as running. Cause: " +
        (error instanceof Error ? error.message : String(error)),
    );
  } finally {
    if (temporal !== null) await temporal.close();
  }
}

/** What the engineering turn needs from the ports, once they exist. */
interface TurnPorts {
  readonly llm: LlmPort;
  readonly storage: StoragePort;
}

interface BuiltTurnRunner {
  readonly runner: CoreDeps["execution"];
  /**
   * Why the turn still cannot run, or `null` when it can. Feeds
   * `degradedCapabilities` so the boot banner and the code agree.
   */
  readonly degradedReason: string | null;
}

/**
 * The engineering turn's runner, built from the ports and the sandbox fleet.
 *
 * Three collaborators used to be missing here and the seam refused by name.
 * They exist now (`@maestro/execution`), so the only thing that can still stop
 * this is DEPLOYMENT configuration: the fleet needs a digest-pinned image, and
 * the runner's own schema refuses an unpinned one (M27).
 *
 * When that image is unset the refusal is narrower than the old one and says
 * something different — "this deployment has no sandbox fleet configured", not
 * "nobody implemented this". An operator can fix the first by setting one
 * variable.
 */
export function buildTurnRunner(env: DeployEnv, db: Db, ports: TurnPorts): BuiltTurnRunner {
  const image = env.RUNNER_IMAGE_LINUX;
  if (image === undefined) {
    return {
      runner: unrunnableTurnRunner(
        "execution: no sandbox fleet is configured — RUNNER_IMAGE_LINUX is unset, and an " +
          "engineering turn runs the agent's verification commands inside a digest-pinned " +
          "container (M21/M27). Set it to a pinned reference to enable the turn.",
      ),
      degradedReason:
        "AgentTurnRunner (M30/M52/M54): implemented and wired, but this deployment has no sandbox " +
        "fleet — RUNNER_IMAGE_LINUX is unset, so the engineering turn refuses with a named error. " +
        "Set it to a digest-pinned image to enable the turn; every other step is unaffected.",
    };
  }

  const runnerConfig = {
    socketPath: env.DOCKER_SOCKET_PATH,
    platforms: { "linux-node": { image } },
    /**
     * The network the sandbox runs on (M26).
     *
     * Passing it is what turns egress confinement ON: `verifyEgressNetwork`
     * returns immediately when no name is configured, and a container with no
     * network setting joins the daemon's default bridge — which reaches the
     * internet. An agent session reading a bank's repository must not.
     *
     * The driver verifies the network is `Internal: true` before it runs
     * anything, so a name that points at a bridge with egress fails closed
     * rather than confining nothing.
     */
    ...(env.RUNNER_NETWORK === undefined
      ? {}
      : { egress: { networkName: env.RUNNER_NETWORK } }),
    /**
     * Relaxations an operator has named, and the runner's schema will only
     * honour outside production (M6).
     *
     * `direct-egress` is the one a development stack needs: the network is
     * already `Internal: true`, so nothing reaches the internet, but the driver
     * still wants an egress PROXY — because an internal network stops the
     * traffic while a proxy is what RECORDS the attempt. That record is the
     * part a bank audit asks for, which is why the relaxation exists as a
     * named opt-in rather than a default, and why production refuses it
     * outright no matter what this variable says.
     */
    ...(env.RUNNER_ALLOW_UNSAFE === undefined
      ? {}
      : { sandbox: { allowUnsafeProfile: env.RUNNER_ALLOW_UNSAFE.split(",").map((entry) => entry.trim()) } }),
  };
  const fleet = createDockerLinuxRunner(runnerConfig);

  return {
    runner: buildAgentTurnRunner({
      runner: fleet,
      llm: ports.llm,
      storage: ports.storage,
      piiPolicy: defaultPiiPolicy(),
      counters: db.strikeCounter,
      platform: "linux-node",
      /**
       * MUST be the runner's own tail budget. A verification result whose
       * output filled the tail is treated as a failure, because `tail()` drops
       * the HEAD of the stream and a cut test report cannot be shown to have
       * come from the run it appears to describe. Reading the default from the
       * same schema the runner parsed is what keeps the two in step.
       */
      tailLimitBytes: DEFAULT_MAX_TAIL_BYTES,
      commandTimeoutSeconds: env.RUNNER_COMMAND_TIMEOUT_SECONDS,
    }),
    degradedReason: null,
  };
}

/**
 * The runner's `maxTailBytes` default, mirrored.
 *
 * `DockerRunnerConfig` owns the number and this deployment does not override
 * it. Mirrored rather than imported because the config type is the parsed
 * shape, not a constant — and a wrong value here fails SAFE in only one
 * direction, so it is stated where it can be seen rather than inferred.
 */
const DEFAULT_MAX_TAIL_BYTES = 16_384;

if (isEntrypoint(import.meta.url)) {
  await main().catch(fail);
}
