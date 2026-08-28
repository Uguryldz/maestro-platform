import { SandboxAgentTurnRunner, PersistentStrikeLedger, type StrikeStore } from "@maestro/execution";
import { defaultPiiPolicy } from "@maestro/pii";
import type { PlatformProfile } from "@maestro/contracts";
import type { LlmOutcome, RunnerLease, RunnerPort, RunJob, RunResult } from "@maestro/ports";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createActivities } from "../src/impl/index.js";
import { makeFakes } from "./fakes.js";
import { Scenario, createTestEnv, runTicket } from "./harness.js";

/**
 * Step 6a, end to end, with the REAL turn runner.
 *
 * Every other test in this suite fakes `execution` and asserts what the
 * workflow does with the answer. This one wires the actual
 * `SandboxAgentTurnRunner` — the real workspace probe, the real verification
 * runner and the real strike ledger — into the activity the workflow calls, so
 * what is under test is the engineering turn itself running inside a workflow
 * rather than a stub standing where it used to be.
 *
 * Still offline: `fakeFleet` answers the sandbox and the LLM double answers the
 * session, so no container starts and no model is called.
 */

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await createTestEnv();
});

afterAll(async () => {
  await env?.teardown();
});

/** NUL-delimited porcelain, the format the probe asks git for. */
function porcelainZ(entries: readonly string[]): string {
  return `${entries.join("\0")}\0`;
}

interface FleetOptions {
  readonly status: string;
  readonly verifyExit?: number;
  /** Fires while a sandbox command is in flight — the kill switch's moment. */
  readonly onSession?: (job: RunJob) => void;
}

interface FakeFleet extends RunnerPort {
  readonly commands: string[];
  leaked(): string[];
}

function fakeFleet(options: FleetOptions): FakeFleet {
  const commands: string[] = [];
  const acquired: string[] = [];
  const released: string[] = [];
  let seq = 0;

  return {
    commands,
    leaked: () => acquired.filter((id) => !released.includes(id)),
    acquire(platform: PlatformProfile): Promise<RunnerLease> {
      seq += 1;
      acquired.push(`lease-${seq}`);
      return Promise.resolve({ leaseId: `lease-${seq}`, runnerId: "r1", platform });
    },
    runSession(_lease: RunnerLease, job: RunJob, signal?: AbortSignal): Promise<RunResult> {
      const line = job.command.join(" ");
      commands.push(line);
      options.onSession?.(job);
      // The contract's hard rule: an aborted session tears down and REJECTS.
      if (signal?.aborted === true) {
        return Promise.reject(
          signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)),
        );
      }
      if (line.includes("status")) {
        return Promise.resolve({ exitCode: 0, stdoutTail: options.status, stderrTail: "", durationMs: 3 });
      }
      if (line.includes("numstat") || line.includes("find")) {
        return Promise.resolve({ exitCode: 0, stdoutTail: "", stderrTail: "", durationMs: 1 });
      }
      return Promise.resolve({
        exitCode: options.verifyExit ?? 0,
        stdoutTail: "42 passing",
        stderrTail: "",
        durationMs: 20,
      });
    },
    mountCache: () => Promise.resolve(),
    release(lease: RunnerLease): Promise<void> {
      released.push(lease.leaseId);
      return Promise.resolve();
    },
  };
}

function memoryStrikeStore(): StrikeStore {
  return {
    load: () => Promise.resolve([]),
    save: () => Promise.resolve(),
    remove: () => Promise.resolve(),
  };
}

/**
 * The engineering activity, backed by the real runner.
 *
 * `createActivities` binds the whole activity set to one `ActivityDeps`, so
 * swapping `execution` for the real thing gives the workflow the genuine step
 * 6a while every other activity stays a fake.
 */
function realEngineering(fleet: RunnerPort, signal?: AbortSignal) {
  const { deps } = makeFakes({
    agentSession: (): LlmOutcome<{ resumeToken: string; finalText: string; log: never }> => ({
      status: "ok",
      value: { resumeToken: "resume-1", finalText: "done", log: undefined as never },
      log: undefined as never,
    }),
  });

  const runner = new SandboxAgentTurnRunner({
    runner: fleet,
    platform: "linux-node",
    tailLimitBytes: 16_384,
    commandTimeoutSeconds: 600,
    ...(signal === undefined ? {} : { signalFor: () => signal }),
    strikes: new PersistentStrikeLedger({ store: memoryStrikeStore(), now: () => new Date() }),
    execution: {
      llm: deps.llm,
      piiPolicy: defaultPiiPolicy(),
      journalSink: () => Promise.resolve(undefined),
      now: () => new Date("2026-08-09T09:00:00+03:00"),
    },
  });

  const activities = createActivities({ ...deps, execution: runner });
  return { runEngineering: activities.runEngineering, fleet };
}

describe("step 6a runs for real inside the workflow", () => {
  it("THE PROOF: the engineering turn probes, verifies and reports through the real runner", async () => {
    const fleet = fakeFleet({ status: porcelainZ([" M src/pay.ts"]) });
    const { runEngineering } = realEngineering(fleet);
    const scenario = new Scenario({ risk: "dusuk" });

    const run = await runTicket(env, scenario, { runEngineering });

    expect(run.failure).toBe("");
    expect(run.status).not.toBeNull();
    // The real probe and the real verifier both ran inside the sandbox.
    expect(fleet.commands.some((c) => c.includes("status"))).toBe(true);
    expect(fleet.commands.some((c) => c.includes("npm") || c.includes("test"))).toBe(true);
    // Nothing was left holding a runner slot.
    expect(fleet.leaked()).toEqual([]);
  });

  it("a protected-path violation STOPS the run and hands it to a human (M52)", async () => {
    // The agent wrote a migration — on the M52 deny-list floor.
    const fleet = fakeFleet({ status: porcelainZ([" M db/migrations/003_add_column.sql"]) });
    const { runEngineering } = realEngineering(fleet);
    const scenario = new Scenario({ risk: "dusuk" });

    const run = await runTicket(env, scenario, { runEngineering });

    /**
     * The run ends in HANDOVER, not merged and not merely "not merged": M52 is
     * fail-closed, so an illegal diff takes the ticket away from the AI and
     * gives it to a human. Asserting the exact terminal status is what stops
     * this passing for a run that failed somewhere else entirely.
     *
     * Two INDEPENDENT layers hold this, and either alone is enough — verified
     * by mutation: disabling `AgentExecution`'s verdict still handed over
     * (because `runEngineering` re-checks `report.protectedViolations`), and
     * emptying the report's violations still handed over (because the verdict
     * fires). Only breaking BOTH reaches `done`. That redundancy is deliberate
     * for the one gate whose failure mode is a merged illegal diff.
     */
    expect(run.status).toBe("handover");
    // The turn got as far as step 6a and no further.
    expect(scenario.journal.some((e) => e.title === "adım 6a")).toBe(true);
    // The probe DID look — a real inspection finding a real violation, not a
    // turn that failed before it got that far.
    expect(fleet.commands.some((c) => c.includes("status"))).toBe(true);
    // And it never spent a build on the illegal diff.
    expect(fleet.commands.some((c) => c.includes("npm test"))).toBe(false);
  });

  it("the kill switch really cuts a turn in flight, rather than relabelling it", async () => {
    const controller = new AbortController();
    const fleet = fakeFleet({
      status: porcelainZ([" M src/pay.ts"]),
      // Fires while the sandbox command is running — the case a check between
      // awaits structurally cannot catch.
      onSession: () => controller.abort(new Error("kill_switch_stop_all")),
    });
    const { runEngineering } = realEngineering(fleet, controller.signal);
    const scenario = new Scenario({ risk: "dusuk" });

    const run = await runTicket(env, scenario, { runEngineering });

    // The run did NOT complete: a cancelled turn must not read as a finished
    // one, which is exactly the bug this closes.
    /**
     * The run stopped, and it stopped BECAUSE of the switch.
     *
     * Asserting only "did not merge" would pass for any failure at all —
     * including one where the signal never reached `runSession` and the turn
     * failed for an unrelated reason. Naming the abort in the failure chain is
     * what makes this a kill-switch test rather than a "something went wrong"
     * test, and it is what fails when the signal stops being passed down.
     */
    expect(run.status).toBeNull();
    expect(run.failure).toContain("kill_switch_stop_all");
    expect(fleet.leaked()).toEqual([]);
  });

  it("without the switch the same turn completes — the abort is the cause, not the setup", async () => {
    const fleet = fakeFleet({ status: porcelainZ([" M src/pay.ts"]) });
    const { runEngineering } = realEngineering(fleet);
    const scenario = new Scenario({ risk: "dusuk" });

    const run = await runTicket(env, scenario, { runEngineering });

    // The control for the test above: same fleet, same turn, no signal.
    expect(run.failure).not.toContain("kill_switch_stop_all");
  });
});
