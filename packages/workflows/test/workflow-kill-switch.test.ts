import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { killSwitchSignal } from "../src/signals.js";
import { PASS_SCAN, Scenario, approval, createTestEnv, runTicket } from "./harness.js";

/**
 * The emergency stop (M58), under time skipping.
 *
 * Two levels, and the difference between them is the whole test: level ② stops
 * this run wherever it is, and must beat work already in flight — above all the
 * MERGE, the one act in the system that cannot be undone. Level ① pauses the
 * intake of NEW work, so a run already under way continues — but says so, 
 * because a lever that silently does nothing is worse than one that refuses.
 */

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await createTestEnv();
});

afterAll(async () => {
  await env?.teardown();
});

describe("the kill switch (M58)", () => {
  it("stops the flow between steps but never abandons an open gate", async () => {
    const scenario = new Scenario({
      risk: "dusuk",
      gate: (step) => (step === "5" ? { kind: "approve_after_hours", hours: 5 } : { kind: "approve" }),
    });
    const run = await runTicket(env, scenario, {
      escalateGate: async (_ticket, step, waitingHours) => {
        scenario.escalations.push({ step, hours: waitingHours });
        if (step === "5" && waitingHours === 2) {
          await scenario.handle?.signal(killSwitchSignal, {
            level: "all",
            actor: "admin@bank",
            reason: "olay müdahalesi",
            at: "2026-08-09T09:00:00+03:00",
          });
        }
        if (step === "5" && waitingHours >= 5) await scenario.signal(approval("5"));
        return null;
      },
    });

    // The run stopped — but only after the gate it was holding had been answered.
    expect(run.status).toBeNull();
    expect(run.failure).toContain("kill switch: all");
    const ticks = scenario.escalations.filter((e) => e.step === "5");
    expect(Math.max(...ticks.map((t) => t.hours))).toBe(5);
    expect(scenario.decisions.filter((d) => d.step === "5")).toHaveLength(1);
    expect(scenario.journal.some((e) => e.title === "kill-switch")).toBe(true);
  });

  it("human-only work is handed over immediately and opens no gate (M73)", async () => {
    const run = await runTicket(env, new Scenario({ mode: "human_only" }));
    expect(run.status).toBe("handover");
    expect(run.scenario.opened).toEqual([]);
    expect(run.scenario.handovers).toEqual(["human_only"]);
  });

  /**
   * The merge is the one irreversible act in the system. A kill switch that
   * arrives while the last gate is being decided must stop it — the whole
   * point of an emergency stop is that it beats work already in flight.
   */
  it("a kill arriving at the last gate stops the MERGE (K1)", async () => {
    const scenario = new Scenario({ risk: "dusuk" });
    const merges: string[] = [];
    const run = await runTicket(env, scenario, {
      recordGateDecision: async (_ticket, decision) => {
        scenario.decisions.push(decision);
        // The admin hits the switch in the very window the approval is being
        // written down: decided, but nothing irreversible done yet.
        if (decision.step === "12") {
          await scenario.handle?.signal(killSwitchSignal, {
            level: "all",
            actor: "admin@bank",
            reason: "olay müdahalesi",
            at: "2026-08-09T09:00:00+03:00",
          });
        }
        return { accepted: true as const };
      },
      mergePullRequest: async () => {
        merges.push("MERGED");
        return { mergeSha: "abcdef1" };
      },
    });

    expect(run.failure).toContain("kill switch: all");
    // Nothing irreversible happened, and nothing downstream of it either.
    expect(merges).toEqual([]);
    expect(run.status).not.toBe("done");
    expect(scenario.journal.some((e) => e.title === "kanıt paketi")).toBe(false);
  });

  /**
   * A kill during the engineering loop must stop the NEXT step, not merely the
   * next lap. Scans, reviews and test runs all start new sandbox work.
   */
  it("a kill inside the engineering loop stops the step chain (K2)", async () => {
    const scenario = new Scenario({ risk: "dusuk" });
    const calls: string[] = [];
    const run = await runTicket(env, scenario, {
      runEngineering: async (_ticket, resumeToken, task) => {
        scenario.engineering.push({ resumeToken, task });
        calls.push("ENGINEERING");
        await scenario.handle?.signal(killSwitchSignal, {
          level: "all",
          actor: "admin@bank",
          reason: "olay müdahalesi",
          at: "2026-08-09T09:00:00+03:00",
        });
        return { ok: true, resumeToken: resumeToken ?? "session-1", changedFiles: 3, diffSummary: "+30 -4" };
      },
      runScans: async () => {
        calls.push("SCANS");
        return [PASS_SCAN];
      },
      reviewDiff: async () => {
        calls.push("REVIEW");
        return { approved: true, findings: [] };
      },
      runTests: async () => {
        calls.push("TESTS");
        return { passed: true, total: 42, failed: 0, coveragePct: 88 };
      },
    });

    expect(run.failure).toContain("kill switch: all");
    // The turn that was already running finished; nothing after it began.
    expect(calls).toEqual(["ENGINEERING"]);
  });

  /**
   * Level ① pauses INTAKE. It must not silently do nothing: either it stops the
   * run before new work starts, or the ledger says why it did not apply (M14).
   */
  it("level ① is never silent (K3)", async () => {
    const scenario = new Scenario({ risk: "dusuk" });
    const run = await runTicket(env, scenario, {
      journal: async (_ticket, kind, title, detail) => {
        scenario.journal.push({ kind, title, detail });
        if (title === "adım 10b") scenario.ciGateOpen = true;
        if (title === "adım 0") {
          await scenario.handle?.signal(killSwitchSignal, {
            level: "intake_only",
            actor: "admin@bank",
            reason: "yeni iş alımı durduruldu",
            at: "2026-08-09T09:00:00+03:00",
          });
        }
      },
    });

    // Whatever the workflow decides to do with level ①, it must SAY so.
    const noted = scenario.journal.filter((e) => e.title === "kill-switch");
    expect(noted.length).toBeGreaterThan(0);
    expect(noted.some((e) => e.detail.includes("①") || e.detail.includes("intake"))).toBe(true);
    expect(run.error === null || run.failure.includes("kill switch")).toBe(true);
  });
});
