import { defaultPiiPolicy } from "@maestro/pii";
import { describe, expect, it } from "vitest";
import type { SessionReport } from "../src/collect.js";
import { PersistentStrikeLedger, type StrikeStore } from "../src/persistent-strikes.js";
import { SandboxAgentTurnRunner } from "../src/turn-runner.js";
import { TRUNCATED_EXIT_CODE } from "../src/verification-runner.js";
import { bootstrapContext, okSession, stubLlm, tickingClock } from "./helpers.js";
import { fakeRunner, porcelainZ, type FakeRunnerOptions } from "./runner-helpers.js";

/**
 * The engineering turn (6a), end to end over a fake runner and a fake driver.
 *
 * No network, no LLM, no container: `stubLlm` answers the session and
 * `fakeRunner` answers the sandbox, so these assert the WIRING — that the M52
 * gate stops the turn, that a kill switch reaches a running build, and that the
 * lease comes back on every path.
 */

const CLEAN: FakeRunnerOptions["responses"] = [
  { match: "status", result: { stdoutTail: porcelainZ([" M src/pay.ts"]) } },
  { match: "numstat", result: { stdoutTail: "5\t1\tsrc/pay.ts\0" } },
  { match: "find", result: { stdoutTail: "" } },
];

function memoryStore(): StrikeStore {
  const rows = new Map<string, never>();
  return {
    load: () => Promise.resolve([]),
    save: () => Promise.resolve(),
    remove: () => Promise.resolve(void rows),
  };
}

interface Built {
  readonly runner: SandboxAgentTurnRunner;
  readonly reports: SessionReport[];
  readonly strikes: PersistentStrikeLedger;
}

function build(
  fake: ReturnType<typeof fakeRunner>,
  over: { signal?: AbortSignal; limit?: number; tailLimitBytes?: number } = {},
): Built {
  const reports: SessionReport[] = [];
  const strikes = new PersistentStrikeLedger({
    store: memoryStore(),
    now: tickingClock(),
    ...(over.limit === undefined ? {} : { limit: over.limit }),
  });

  const runner = new SandboxAgentTurnRunner({
    runner: fake,
    platform: "linux-node",
    strikes,
    tailLimitBytes: over.tailLimitBytes ?? 1024,
    commandTimeoutSeconds: 600,
    ...(over.signal === undefined ? {} : { signalFor: () => over.signal }),
    execution: {
      llm: stubLlm([okSession(), okSession(), okSession()]),
      piiPolicy: defaultPiiPolicy(),
      journalSink: (masked) => {
        reports.push(masked.value as SessionReport);
        return Promise.resolve(undefined);
      },
      now: tickingClock(),
    },
  });
  return { runner, reports, strikes };
}

const REQUEST = {
  context: bootstrapContext(),
  dataClass: "dahili" as const,
  variantId: "v1",
  verification: [{ name: "test", command: ["npm", "test"] }],
};

describe("the engineering turn runs end to end (6a)", () => {
  it("inspects the workspace, verifies it, and reports what changed", async () => {
    const fake = fakeRunner({ responses: CLEAN });
    const { runner, reports } = build(fake);

    const result = await runner.runTurn(REQUEST);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.report.changedFiles).toHaveLength(1);
    expect(result.report.diff).toEqual({ files: 1, insertions: 5, deletions: 1 });
    expect(result.report.commands[0]).toMatchObject({ name: "test", exitCode: 0 });
    // The journal was written — masked, through the M20 boundary.
    expect(reports).toHaveLength(1);
    expect(fake.leaked()).toEqual([]);
  });

  it("resumes the SAME session when a token is supplied (M30)", async () => {
    const fake = fakeRunner({ responses: CLEAN });
    const reports: SessionReport[] = [];
    const llm = stubLlm([okSession(), okSession()]);
    const runner = new SandboxAgentTurnRunner({
      runner: fake,
      platform: "linux-node",
      strikes: new PersistentStrikeLedger({ store: memoryStore(), now: tickingClock() }),
      tailLimitBytes: 1024,
      commandTimeoutSeconds: 600,
      execution: {
        llm,
        piiPolicy: defaultPiiPolicy(),
        journalSink: (masked) => {
          reports.push(masked.value as SessionReport);
          return Promise.resolve(undefined);
        },
        now: tickingClock(),
      },
    });

    await runner.runTurn(REQUEST);
    await runner.runTurn({ ...REQUEST, resumeToken: "resume-1" });

    // A new session per turn would lose everything the agent had established.
    expect(llm.calls[1]?.resumeToken).toBe("resume-1");
  });
});

describe("a protected-path violation STOPS the turn (M52)", () => {
  const VIOLATING: FakeRunnerOptions["responses"] = [
    { match: "status", result: { stdoutTail: porcelainZ([" M db/migrations/003_add_column.sql"]) } },
    { match: "numstat", result: { stdoutTail: "" } },
    { match: "find", result: { stdoutTail: "" } },
  ];

  it("fails the turn and names the path — not a warning", async () => {
    const fake = fakeRunner({ responses: VIOLATING });
    const { runner } = build(fake);

    const result = await runner.runTurn(REQUEST);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.reason).toBe("protected_path");
    expect(result.report.protectedViolations[0]?.path).toBe("db/migrations/003_add_column.sql");
  });

  it("does NOT spend a build on an illegal diff", async () => {
    const fake = fakeRunner({ responses: VIOLATING });
    const { runner } = build(fake);

    const result = await runner.runTurn(REQUEST);

    // A green build on top of an illegal change reads like an endorsement.
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.report.commands).toEqual([]);
    expect(fake.jobs.some((j) => j.job.command.join(" ").includes("npm test"))).toBe(false);
  });

  it("hands over on the FIRST offence — M52 does not get three tries", async () => {
    const fake = fakeRunner({ responses: VIOLATING });
    const { runner } = build(fake, { limit: 1 });

    const result = await runner.runTurn(REQUEST);

    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.handover.handover).toBe(true);
    expect(result.handover.workMode).toBe("ai_assist");
  });

  it("catches a hook dropped into .git/, which no git status reports", async () => {
    const fake = fakeRunner({
      responses: [
        { match: "status", result: { stdoutTail: "" } },
        { match: "numstat", result: { stdoutTail: "" } },
        { match: "find", result: { stdoutTail: "./hooks/post-checkout\0" } },
      ],
    });
    const { runner } = build(fake);

    const result = await runner.runTurn(REQUEST);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.report.protectedViolations[0]?.path).toBe(".git/hooks/post-checkout");
  });
});

describe("the kill switch really cuts the turn (M58)", () => {
  it("THE POINT: stop_all rejects the turn instead of relabelling a finished one", async () => {
    const controller = new AbortController();
    // Fires while the sandbox command is in flight — the case a between-awaits
    // check cannot catch.
    const fake = fakeRunner({
      responses: CLEAN,
      onSession: () => controller.abort(new Error("kill_switch_stop_all")),
    });
    const { runner } = build(fake, { signal: controller.signal });

    await expect(runner.runTurn(REQUEST)).rejects.toThrow(/kill_switch_stop_all/);
  });

  it("does not report the turn as a completed one", async () => {
    const controller = new AbortController();
    const fake = fakeRunner({
      responses: CLEAN,
      onSession: () => controller.abort(new Error("kill_switch_stop_all")),
    });
    const { runner, reports } = build(fake, { signal: controller.signal });

    await runner.runTurn(REQUEST).catch(() => undefined);

    // A journalled report would be a run that looks finished to every reader.
    expect(reports).toEqual([]);
  });

  it("does not spend a strike on the platform's own decision", async () => {
    const controller = new AbortController();
    const fake = fakeRunner({
      responses: CLEAN,
      onSession: () => controller.abort(new Error("kill_switch_stop_all")),
    });
    const { runner, strikes } = build(fake, { signal: controller.signal });

    await runner.runTurn(REQUEST).catch(() => undefined);

    // Otherwise three kill-switch presses hand a human a ticket whose "three
    // failed attempts" were three operator decisions.
    expect(strikes.stuckKeys("run-000001")).toEqual([]);
  });

  it("tears the sandbox down — no lease is left behind", async () => {
    const controller = new AbortController();
    const fake = fakeRunner({
      responses: CLEAN,
      onSession: () => controller.abort(new Error("kill_switch_stop_all")),
    });
    const { runner } = build(fake, { signal: controller.signal });

    await runner.runTurn(REQUEST).catch(() => undefined);

    expect(fake.leaked()).toEqual([]);
  });

  it("refuses before taking a lease when the switch is already down", async () => {
    const controller = new AbortController();
    controller.abort(new Error("kill_switch_stop_all"));
    const fake = fakeRunner({ responses: CLEAN });
    const { runner } = build(fake, { signal: controller.signal });

    await expect(runner.runTurn(REQUEST)).rejects.toThrow(/kill_switch_stop_all/);
    // An acquire here would occupy a pool slot for work that must not start.
    expect(fake.acquired).toEqual([]);
  });
});

describe("a truncated verification report reaches the ladder as a failure", () => {
  it("fails the turn rather than passing it", async () => {
    const fake = fakeRunner({
      responses: [
        ...(CLEAN ?? []),
        { match: "npm test", result: { exitCode: 0, stdoutTail: "x".repeat(64) } },
      ],
    });
    const { runner } = build(fake, { tailLimitBytes: 64 });

    const result = await runner.runTurn(REQUEST);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.reason).toBe("verification");
    expect(result.report.commands[0]?.exitCode).toBe(TRUNCATED_EXIT_CODE);
  });
});

describe("the lease is returned on every path", () => {
  it("after a failed verification", async () => {
    const fake = fakeRunner({
      responses: [...(CLEAN ?? []), { match: "npm test", result: { exitCode: 1, stdoutTail: "3 failing" } }],
    });
    const { runner } = build(fake);

    const result = await runner.runTurn(REQUEST);

    expect(result.status).toBe("failed");
    expect(fake.leaked()).toEqual([]);
  });

  it("after a probe failure", async () => {
    const fake = fakeRunner({ responses: [{ match: "status", result: { exitCode: 128, stderrTail: "fatal" } }] });
    const { runner } = build(fake);

    await expect(runner.runTurn(REQUEST)).rejects.toThrow(/could not be inspected/);
    expect(fake.leaked()).toEqual([]);
  });
});
