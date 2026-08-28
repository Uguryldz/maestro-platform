import { fileURLToPath } from "node:url";
import type { WorkflowHandle } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { DefaultLogger, Runtime, Worker } from "@temporalio/worker";
import type { WorkflowRunStatus } from "@maestro/contracts";
import type { MaestroActivities } from "../src/activities.js";
import { ciResultSignal } from "../src/signals.js";
import { ticketWorkflow } from "../src/ticket-workflow.js";
import { Scenario, TICKET, makeActivities } from "./scenario.js";

/**
 * Runs one ticket end to end against a local time-skipping Temporal server.
 * Nothing here reaches the network: the workflow is bundled from source and
 * every activity is a stub from `scenario.ts`.
 */

export * from "./scenario.js";

// The SDK logs every worker state change at INFO; a suite that runs a worker
// per test would drown its own failures in them. Installed once per process.
try {
  Runtime.install({ logger: new DefaultLogger("ERROR") });
} catch {
  /* already installed by another file in this worker process */
}

/**
 * The local time-skipping server.
 *
 * The SDK's default is `cached-download`, which fetches the test-server binary
 * from the internet the first time it runs. That is fine on a developer's
 * machine and impossible in the bank's CI, so `MAESTRO_TEST_SERVER` points at a
 * binary that is already on disk. Everything else about the suite is offline
 * either way — the server itself is local, and no activity does I/O.
 */
export function createTestEnv(): Promise<TestWorkflowEnvironment> {
  const executablePath = process.env["MAESTRO_TEST_SERVER"];
  return TestWorkflowEnvironment.createTimeSkipping(
    executablePath === undefined
      ? {}
      : { server: { executable: { type: "existing-path", path: executablePath } } },
  );
}

export interface RunResult {
  status: WorkflowRunStatus | null;
  error: Error | null;
  /** Every message in the failure's cause chain — the workflow's own is last. */
  failure: string;
  scenario: Scenario;
}

/**
 * Temporal wraps a workflow failure twice ("Workflow execution failed" →
 * `ApplicationFailure`), so the reason the workflow actually gave is two
 * `cause` hops down. Asserting on the outer message would pass for any failure
 * whatsoever.
 */
export function failureChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(" | ");
}

let workflowId = 0;

/** Real milliseconds given to the activities between two clock advances. */
const SETTLE_MS = 10;
/** Workflow time added per driver turn. The gate's own timer is one hour. */
const CLOCK_STEP_MS = 12 * 60 * 60 * 1000;
/** Ceiling on driver turns: a stuck run must fail the test, not hang it. */
const MAX_TURNS = 2000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function isClosed(handle: WorkflowHandle): Promise<boolean> {
  const description = await handle.describe();
  return description.status.name !== "RUNNING";
}

/**
 * The world the workflow runs in: a clock and a build pipeline.
 *
 * Time is advanced EXPLICITLY, one chunk at a time, instead of being left to
 * the test server's automatic skipping. Automatic skipping cannot be used here
 * because the CI gate waits on a signal and on no timer at all: with skipping
 * unlocked the server has nothing to skip to except the execution timeout, and
 * it arrives there before any real-world signal can be sent. Driving the clock
 * keeps both halves honest — sixteen days still pass in about a second, and a
 * signal still has real time in which to be delivered.
 */
async function drive(
  env: TestWorkflowEnvironment,
  scenario: Scenario,
  handle: WorkflowHandle,
): Promise<void> {
  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    await delay(SETTLE_MS);
    if (await isClosed(handle)) return;
    if (scenario.ciGateOpen && scenario.takeCiSend()) {
      // Exactly ONE signal per build, like the real pipeline: ADO reports a
      // finished build once and never repeats it. Re-sending on every turn
      // would paper over a workflow that discarded the result it was given.
      await handle.signal(ciResultSignal, scenario.nextCi());
      continue;
    }
    await env.sleep(CLOCK_STEP_MS);
  }
}

/**
 * Start the workflow, drive it to a close, and hand back what happened.
 * Failures are RETURNED rather than thrown: a kill switch stopping a run is an
 * assertion target, not a broken test.
 */
export async function runTicket(
  env: TestWorkflowEnvironment,
  scenario: Scenario,
  overrides: Partial<MaestroActivities> = {},
): Promise<RunResult> {
  workflowId += 1;
  const taskQueue = `maestro-test-${workflowId}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: fileURLToPath(new URL("../src/ticket-workflow.ts", import.meta.url)),
    activities: makeActivities(scenario, overrides),
  });
  const running = worker.run();
  const handle = await env.client.workflow.start(ticketWorkflow, {
    taskQueue,
    workflowId: `ticket-${workflowId}`,
    args: [
      {
        ticket: TICKET,
        // `null` OMITS the field — the analysis-only start intake produces.
        // Absent in the options means the fixture default, which is what every
        // scenario written before analysis-only bindings expects.
        ...(scenario.options.appId === null ? {} : { appId: scenario.options.appId ?? "pay" }),
        mode: scenario.options.mode ?? "full_auto",
        dataClass: "dahili",
        // Absent means the full pipeline, which is what every existing
        // scenario expects; `flow` only narrows it.
        ...(scenario.options.flow === undefined ? {} : { flow: scenario.options.flow }),
        // Absent is comment-only mode, which is what every scenario written
        // before the status map existed expects — and what those scenarios
        // still assert by finding `scenario.moves` empty.
        ...(scenario.options.statusMap === undefined ? {} : { statusMap: scenario.options.statusMap }),
      },
    ],
  });
  scenario.handle = handle;
  try {
    await drive(env, scenario, handle);
    return { status: await handle.result(), error: null, failure: "", scenario };
  } catch (error) {
    return { status: null, error: error as Error, failure: failureChain(error), scenario };
  } finally {
    worker.shutdown();
    await running.catch(() => undefined);
  }
}
