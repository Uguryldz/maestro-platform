import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  LlmPort,
  NotifyPort,
  PortRegistry,
  PublishPort,
  ScanPort,
  ScmPort,
  SecretPort,
  StoragePort,
  WorkPort,
} from "@maestro/ports";
import { NativeConnection, Worker, type WorkerOptions } from "@temporalio/worker";
import type { ActivityDeps } from "./impl/deps.js";
import { InMemoryIdempotency } from "./impl/idempotency.js";
import { createActivities } from "./impl/index.js";

/**
 * The composition root (M44).
 *
 * This is the ONLY file in the platform that decides which driver serves which
 * port, and it does so by NAME: nothing here imports an adapter module, so the
 * core cannot acquire a dependency on Azure DevOps or Jira by accident. The
 * application that boots the worker registers the driver factories it wants,
 * hands the registry in, and gets a worker back.
 */

export const MAESTRO_TASK_QUEUE = "maestro-delivery";

/**
 * Port names as the driver packages register them. They are duplicated here as
 * strings rather than imported, because importing `@maestro/adapter-jira` just
 * to learn that its port is called "work" is the coupling M44 forbids. The
 * source of truth is each package's own constant; `test/worker.test.ts` pins
 * the pair so a rename cannot drift silently.
 */
export const PORT_NAMES = {
  work: "work",
  scm: "scm",
  llm: "llm",
  scan: "scan",
  // Historic spelling in `@maestro/storage`'s registry — kept verbatim.
  storage: "StoragePort",
  secret: "secret",
  notify: "notify",
  publish: "publish",
} as const;

/** Which driver serves one port, and the configuration it is built from. */
export interface DriverChoice {
  readonly driver: string;
  readonly config?: unknown;
}

export type PortSelection = Readonly<Record<keyof typeof PORT_NAMES, DriverChoice>>;

export interface PortBundle {
  readonly work: WorkPort;
  readonly scm: ScmPort;
  readonly llm: LlmPort;
  readonly scan: ScanPort;
  readonly storage: StoragePort;
  readonly secrets: SecretPort;
  readonly notify: NotifyPort;
  readonly publish: PublishPort;
}

/**
 * Resolve every port in one pass. Resolution is fail-closed by way of
 * `PortRegistry.resolve`, which throws (naming the drivers it does have) rather
 * than returning undefined — a worker that starts with a missing driver would
 * only discover it mid-ticket, at a gate.
 */
export function resolvePorts(registry: PortRegistry, selection: PortSelection): PortBundle {
  const build = <P>(key: keyof typeof PORT_NAMES): P => {
    const choice = selection[key];
    return registry.resolve<P>(PORT_NAMES[key], choice.driver)(choice.config);
  };
  return {
    work: build<WorkPort>("work"),
    scm: build<ScmPort>("scm"),
    llm: build<LlmPort>("llm"),
    scan: build<ScanPort>("scan"),
    storage: build<StoragePort>("storage"),
    secrets: build<SecretPort>("secret"),
    notify: build<NotifyPort>("notify"),
    publish: build<PublishPort>("publish"),
  };
}

/** Everything the activities need that is NOT a port (stores, clock, catalog). */
export type CoreDeps = Omit<ActivityDeps, keyof PortBundle>;

export function composeActivityDeps(ports: PortBundle, core: CoreDeps): ActivityDeps {
  return { ...core, ...ports };
}

/**
 * Where the workflow code lives. The worker BUNDLES this file in a sandbox, so
 * it must be a path and not an import: the workflow may not share module state
 * with the activities.
 */
export function workflowsPath(): string {
  const ts = fileURLToPath(new URL("./ticket-workflow.ts", import.meta.url));
  return existsSync(ts) ? ts : fileURLToPath(new URL("./ticket-workflow.js", import.meta.url));
}

export interface MaestroWorkerOptions {
  readonly connection: NativeConnection;
  readonly namespace?: string;
  readonly taskQueue?: string;
  readonly registry: PortRegistry;
  readonly ports: PortSelection;
  readonly core: CoreDeps;
  /** Overrides for the Temporal worker itself (concurrency, grace time…). */
  readonly workerOptions?: Partial<WorkerOptions>;
}

/**
 * Build the worker: the workflow bundle, the activity set, the task queue.
 *
 * `shutdownGraceTime` is deliberately generous. An activity that is killed
 * mid-write leaves the run to be retried from the last completed step, and the
 * engineering turn can legitimately be minutes into a build when a deploy
 * starts — the grace period is what turns a rolling restart into a pause
 * instead of a lost turn.
 */
export async function createMaestroWorker(opts: MaestroWorkerOptions): Promise<Worker> {
  const ports = resolvePorts(opts.registry, opts.ports);
  warnIfGuardIsProcessLocal(opts.core.idempotency);
  return Worker.create({
    connection: opts.connection,
    namespace: opts.namespace ?? "default",
    taskQueue: opts.taskQueue ?? MAESTRO_TASK_QUEUE,
    workflowsPath: workflowsPath(),
    activities: createActivities(composeActivityDeps(ports, opts.core)),
    shutdownGraceTime: "5 minutes",
    ...opts.workerOptions,
  });
}

/**
 * D6: say so, loudly, when the deployment's duplicate protection is only as
 * wide as this process.
 *
 * `InMemoryIdempotency` is correct for M33's "the worker is the single writer",
 * and silently wrong the moment a second worker joins the task queue: two
 * processes retrying the same activity would each believe they were the first,
 * and the ticket would get two Jira comments and two audit records claiming the
 * same predecessor. That is a deployment mistake, not a code one — so this
 * cannot throw — but it must never be discovered from duplicated evidence.
 */
export function warnIfGuardIsProcessLocal(guard: ActivityDeps["idempotency"]): void {
  if (!(guard instanceof InMemoryIdempotency)) return;
  console.warn(
    "[maestro] idempotency guard is process-local (InMemoryIdempotency): safe for a SINGLE " +
      "worker only. Wire a table-backed IdempotencyGuard before running more than one.",
  );
}

/** Signals a long-running worker treats as "drain and stop". */
export const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/**
 * Run until a shutdown signal arrives, then drain.
 *
 * `Worker.run()` resolves once the worker has finished draining, so the
 * handlers only have to ask for the shutdown — they must not race it by
 * exiting the process themselves. The handlers are removed afterwards so a
 * second worker in the same process (tests, a reload) does not inherit them.
 */
export async function runMaestroWorker(
  worker: Worker,
  process_: NodeJS.Process = process,
): Promise<void> {
  const stop = (): void => {
    // Idempotent by design: `shutdown()` on an already-stopping worker is a
    // no-op, so a second Ctrl-C does not turn a graceful drain into a crash.
    worker.shutdown();
  };
  for (const signal of SHUTDOWN_SIGNALS) process_.on(signal, stop);
  try {
    await worker.run();
  } finally {
    for (const signal of SHUTDOWN_SIGNALS) process_.off(signal, stop);
  }
}

/** Convenience for a plain deployment: connect, build, run, drain. */
export async function startMaestroWorker(
  opts: Omit<MaestroWorkerOptions, "connection"> & {
    readonly address: string;
    /**
     * Called with the worker's own state as it changes — `RUNNING` when it is
     * actually polling the queue, anything else when it is not.
     *
     * Exposed so a deployment can answer "can this worker still take work?"
     * truthfully. Asking BEFORE `run()` would only prove the process started,
     * which is the very thing that stays true while a worker is wedged.
     */
    readonly onState?: (state: string) => void;
  },
): Promise<void> {
  const connection = await NativeConnection.connect({ address: opts.address });
  try {
    const worker = await createMaestroWorker({ ...opts, connection });
    const report = opts.onState;
    if (report !== undefined) {
      // Polled rather than subscribed: the SDK exposes `getState()` and no
      // state event, and a one-second poll is far cheaper than the healthcheck
      // interval it feeds.
      const ticker = setInterval(() => report(worker.getState()), 1_000);
      ticker.unref?.();
      try {
        await runMaestroWorker(worker);
      } finally {
        clearInterval(ticker);
        report(worker.getState());
      }
    } else {
      await runMaestroWorker(worker);
    }
  } finally {
    await connection.close();
  }
}
