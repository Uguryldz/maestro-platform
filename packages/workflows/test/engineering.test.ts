import type { LlmCallLog } from "@maestro/contracts";
import type { AgentTurnResult, SessionReport } from "@maestro/execution";
import { describe, expect, it } from "vitest";
import { designTests, reviewDiff, reviewTests, runEngineering, runTests } from "../src/impl/engineering.js";
import { QUOTA_WAIT } from "../src/impl/outcome.js";
import { makeFakes } from "./fakes.js";

const LOG: LlmCallLog = {
  at: "2026-08-09T09:00:00+03:00",
  runId: null,
  role: "dev_reviewer",
  variantId: "v1",
  driver: "openai-compat",
  model: "fake",
  tokensIn: 0,
  tokensOut: 0,
  cachePct: null,
  usd: null,
  dataClass: "dahili",
};

function report(over: Partial<SessionReport> = {}): SessionReport {
  return {
    runId: "run-pay-101-0001",
    ticketKey: "PAY-101",
    resumeToken: "session-2",
    workspacePath: "/w/pay-101",
    finalText: "bitti",
    changedFiles: [],
    diff: { files: 3, insertions: 30, deletions: 4 },
    commands: [
      { name: "test", command: ["pnpm", "test"], exitCode: 0, stdoutTail: "42 passed", stderrTail: "", durationMs: 10 },
    ],
    protectedViolations: [],
    strikes: null,
    at: "2026-08-09T09:05:00+03:00",
    ...over,
  };
}

const ok = (over: Partial<SessionReport> = {}): AgentTurnResult => ({ status: "ok", report: report(over) });

describe("runEngineering (step 6a)", () => {
  it("carries the workflow's resume token into the session (M30)", async () => {
    const fakes = makeFakes({ runTurn: () => ok() });
    const result = await runEngineering(fakes.deps, "PAY-101", "session-1", "kabul kriterleri");

    expect(fakes.recorded.turns[0]?.resumeToken).toBe("session-1");
    expect(result.ok).toBe(true);
    expect(result.resumeToken).toBe("session-2");
    expect(fakes.patches).toContainEqual({ resumeToken: "session-2", workspacePresent: true });
  });

  it("opens a NEW session when there is no token yet", async () => {
    const fakes = makeFakes({ runTurn: () => ok() });
    await runEngineering(fakes.deps, "PAY-101", null, "ilk tur");
    expect(fakes.recorded.turns[0]?.resumeToken).toBeUndefined();
  });

  it("gives a new session the journal and the living summary as its context", async () => {
    const fakes = makeFakes({ runTurn: () => ok() });
    await runEngineering(fakes.deps, "PAY-101", null, "ilk tur");
    await runEngineering(fakes.deps, "PAY-101", "session-2", "ikinci tur");

    // The first turn had nothing to summarise; the second one did.
    expect(fakes.recorded.turns[0]?.context.livingSummary).toBeNull();
    expect(fakes.recorded.turns[1]?.context.livingSummary).not.toBeNull();
    expect(fakes.recorded.turns[1]?.context.journal.length).toBeGreaterThan(0);
  });

  it("a protected-path violation is a handover on the first offence (M52)", async () => {
    const violation = {
      status: "failed" as const,
      reason: "protected_path" as const,
      report: report({
        protectedViolations: [{ path: "db/migrations/001.sql", pattern: "**/migrations/**", status: "added" }],
      }),
      handover: {
        handover: false,
        key: { runId: "run-pay-101-0001", scope: "agent" as const, ref: "protected_path" },
        count: 1,
        limit: 3,
        workMode: "ai_assist" as const,
        messageKey: "run.handover_stuck",
        reasons: [],
      },
    };
    const fakes = makeFakes({ runTurn: () => violation });
    const result = await runEngineering(fakes.deps, "PAY-101", "session-1", "task");

    expect(result.ok).toBe(false);
    expect(result.handoverReason).toContain("db/migrations/001.sql");
  });

  it("a red build only hands over once the strike limit is reached (M54)", async () => {
    const failed = (count: number): AgentTurnResult => ({
      status: "failed",
      reason: "verification",
      report: report(),
      handover: {
        handover: count >= 3,
        key: { runId: "run-pay-101-0001", scope: "ci", ref: "fp" },
        count,
        limit: 3,
        workMode: "ai_assist",
        messageKey: "run.handover_stuck",
        reasons: [],
      },
    });

    const early = makeFakes({ runTurn: () => failed(1) });
    expect((await runEngineering(early.deps, "PAY-101", "s", "t")).handoverReason).toBeUndefined();

    const stuck = makeFakes({ runTurn: () => failed(3) });
    expect((await runEngineering(stuck.deps, "PAY-101", "s", "t")).handoverReason).toContain("M54");
  });

  it("a quota wait is retryable; the run parks instead of failing (M55)", async () => {
    const fakes = makeFakes({
      runTurn: () => ({ status: "queued", resumeAt: "2026-08-09T14:00:00+03:00" }),
    });
    await expect(runEngineering(fakes.deps, "PAY-101", "s", "t")).rejects.toMatchObject({
      type: QUOTA_WAIT,
    });
  });

  it("a degraded gateway hands the turn to a human and keeps the token", async () => {
    const fakes = makeFakes({ runTurn: () => ({ status: "degraded", messageKey: "llm.degraded" }) });
    const result = await runEngineering(fakes.deps, "PAY-101", "session-1", "t");

    expect(result.ok).toBe(false);
    expect(result.handoverReason).toContain("M97");
    expect(result.resumeToken).toBe("session-1");
  });

  /**
   * O4: a policy block DOES hand the ticket to a human, and the handover is
   * fully recorded — but the activity then throws, so the run closes as a
   * failure and Studio shows "başarısız" for a ticket that is sitting in
   * somebody's queue, correctly handed over. The two facts must agree.
   */
  it("a policy block is reported as a handover, not a bare failure (O4)", async () => {
    const fakes = makeFakes({
      runTurn: () => ({ status: "blocked", messageKey: "llm.blocked", dataClass: "gizli" }),
    });
    const result = await runEngineering(fakes.deps, "PAY-101", "session-1", "t");

    expect(result.ok).toBe(false);
    expect(result.handoverReason).toContain("llm.blocked");
    // The handover itself was recorded before the decision came back.
    expect(fakes.journalStore.entries.some((e) => e.kind === "handover")).toBe(true);
  });
});

describe("the AI reviews (steps 6c and 8)", () => {
  it("passes findings through so the next turn can act on them", async () => {
    const fakes = makeFakes({
      generateObject: () => ({ status: "ok", value: { approved: false, findings: ["test yok"] }, log: LOG }),
    });
    expect(await reviewDiff(fakes.deps, "PAY-101")).toEqual({ approved: false, findings: ["test yok"] });
  });

  it("a degraded gateway is NOT an approval", async () => {
    const fakes = makeFakes({
      generateObject: () => ({ status: "degraded", messageKey: "llm.degraded", dataClass: "gizli" }),
    });
    const verdict = await reviewTests(fakes.deps, "PAY-101");
    expect(verdict.approved).toBe(false);
    expect(verdict.findings[0]).toContain("M97");
  });

  it("designTests journals the scenario count", async () => {
    const fakes = makeFakes({
      generateObject: () => ({ status: "ok", value: { scenarios: 6 }, log: LOG }),
    });
    expect(await designTests(fakes.deps, "PAY-101")).toEqual({ scenarios: 6 });
    expect(fakes.journalStore.entries.at(-1)?.detail).toBe("6 senaryo");
  });
});

describe("runTests (step 10)", () => {
  const digest = { status: "ok" as const, value: { total: 42, failed: 0, coveragePct: 88 }, log: LOG };

  it("is green only when every command exited zero", async () => {
    const fakes = makeFakes({ runTurn: () => ok(), generateObject: () => digest });
    expect(await runTests(fakes.deps, "PAY-101")).toEqual({
      passed: true,
      total: 42,
      failed: 0,
      coveragePct: 88,
    });
  });

  it("a summariser that claims success over a red build cannot open the PR", async () => {
    const red = ok({
      commands: [
        { name: "test", command: ["pnpm", "test"], exitCode: 1, stdoutTail: "1 failed", stderrTail: "", durationMs: 9 },
      ],
    });
    const fakes = makeFakes({ runTurn: () => red, generateObject: () => digest });
    const result = await runTests(fakes.deps, "PAY-101");

    // The model said "0 failed"; the exit code said otherwise, and it wins.
    expect(result.passed).toBe(false);
    expect(fakes.journalStore.entries.at(-1)?.title).toBe("testler kırmızı");
  });
});
