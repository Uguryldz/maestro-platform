import type { LlmCallLog, RoutingRule, TicketSnapshot } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import { askClarification, matchApplication, pickRule, runIntake, ruleApplies } from "../src/impl/intake.js";
import { QUOTA_WAIT } from "../src/impl/outcome.js";
import { SNAPSHOT, makeFakes } from "./fakes.js";

const LOG: LlmCallLog = {
  at: "2026-08-09T09:00:00+03:00",
  runId: null,
  role: "intake",
  variantId: "v1",
  driver: "openai-compat",
  model: "fake",
  tokensIn: 0,
  tokensOut: 0,
  cachePct: null,
  usd: null,
  dataClass: "dahili",
};

const rule = (over: Partial<RoutingRule> = {}): RoutingRule =>
  ({
    ruleId: "r1",
    projectKey: "PAY",
    condition: { type: "component", component: "payments" },
    priority: 10,
    effect: { appId: "pay" },
    ...over,
  }) as RoutingRule;

describe("routing rules (M99 tier ①)", () => {
  it("matches on project, component and label; ignores other projects", () => {
    expect(ruleApplies(rule(), SNAPSHOT)).toBe(true);
    expect(ruleApplies(rule({ projectKey: "OTHER" }), SNAPSHOT)).toBe(false);
    expect(ruleApplies(rule({ projectKey: "*" }), SNAPSHOT)).toBe(true);
    expect(ruleApplies(rule({ condition: { type: "label", label: "maestro" } }), SNAPSHOT)).toBe(true);
    expect(ruleApplies(rule({ condition: { type: "label", label: "nope" } }), SNAPSHOT)).toBe(false);
    expect(ruleApplies(rule({ condition: { type: "always" } }), SNAPSHOT)).toBe(true);
  });

  it("the highest priority wins, and a tie is broken deterministically", () => {
    const low = rule({ ruleId: "b", priority: 1 });
    const high = rule({ ruleId: "a", priority: 9 });
    expect(pickRule([low, high], SNAPSHOT)?.ruleId).toBe("a");
    // Same priority, opposite input order — the answer may not depend on it.
    const tieA = rule({ ruleId: "aaa", priority: 5 });
    const tieB = rule({ ruleId: "bbb", priority: 5 });
    expect(pickRule([tieA, tieB], SNAPSHOT)?.ruleId).toBe("aaa");
    expect(pickRule([tieB, tieA], SNAPSHOT)?.ruleId).toBe("aaa");
  });

  it("a rule with no application is not a match", () => {
    expect(pickRule([rule({ effect: { mode: "ai_assist" } })], SNAPSHOT)).toBeNull();
  });
});

describe("matchApplication", () => {
  it("prefers a rule and never asks the model", async () => {
    const fakes = makeFakes({ rules: [rule()] });
    const match = await matchApplication(fakes.deps, "PAY-101");
    expect(match).toEqual({ via: "rule", ruleId: "r1", appId: "pay" });
    expect(fakes.recorded.llm).toEqual([]);
  });

  it("falls back to a confident AI suggestion the gate still has to confirm", async () => {
    const fakes = makeFakes({
      generateObject: () => ({ status: "ok", value: { appId: "pay", confidence: 0.9 }, log: LOG }),
    });
    const match = await matchApplication(fakes.deps, "PAY-101");
    expect(match).toEqual({ via: "ai_suggestion", appId: "pay", confidence: 0.9, validatedAtGate: false });
  });

  it("stops rather than guessing when confidence is low (M14/M99 tier ③)", async () => {
    const fakes = makeFakes({
      generateObject: () => ({ status: "ok", value: { appId: "pay", confidence: 0.2 }, log: LOG }),
    });
    expect(await matchApplication(fakes.deps, "PAY-101")).toBeNull();
  });

  it("records the assignment on the audit chain", async () => {
    const fakes = makeFakes({ rules: [rule()] });
    await matchApplication(fakes.deps, "PAY-101");
    const events = await fakes.chain.verify();
    expect(events.ok).toBe(true);
    expect(events.checked).toBe(1);
  });
});

describe("runIntake", () => {
  it("passes a complete ticket through and journals the verdict", async () => {
    const fakes = makeFakes({
      generateObject: () => ({ status: "ok", value: { complete: true }, log: LOG }),
    });
    expect(await runIntake(fakes.deps, "PAY-101")).toEqual({ complete: true });
    expect(fakes.journalStore.entries.at(-1)?.title).toBe("ticket eksiksiz");
  });

  it("returns the clarification question when the ticket is short", async () => {
    const fakes = makeFakes({
      generateObject: () => ({
        status: "ok",
        value: { complete: false, question: "hangi ortamda?" },
        log: LOG,
      }),
    });
    expect(await runIntake(fakes.deps, "PAY-101")).toEqual({
      complete: false,
      question: "hangi ortamda?",
    });
  });

  it("refuses a verdict that says 'incomplete' without asking anything", async () => {
    const fakes = makeFakes({
      generateObject: () => ({ status: "ok", value: { complete: false }, log: LOG }),
    });
    await expect(runIntake(fakes.deps, "PAY-101")).rejects.toThrow();
  });

  it("a quota wait is a RETRYABLE failure, so Temporal holds the run (M55)", async () => {
    const fakes = makeFakes({
      generateObject: () => ({
        status: "queued",
        resumeAt: "2026-08-09T14:00:00+03:00",
        reason: "subscription_quota",
      }),
    });
    await expect(runIntake(fakes.deps, "PAY-101")).rejects.toMatchObject({ type: QUOTA_WAIT });
    expect(fakes.journalStore.entries.at(-1)?.kind).toBe("quota");
  });

  it("a degraded gateway drops to ai-assist and asks the reporter instead (M97)", async () => {
    const fakes = makeFakes({
      generateObject: () => ({ status: "degraded", messageKey: "llm.degraded", dataClass: "gizli" }),
    });
    const verdict = await runIntake(fakes.deps, "PAY-101");
    expect(verdict.complete).toBe(false);
    expect(verdict.question).toContain("intake.manual_completion");
    expect(fakes.patches).toContainEqual({ mode: "ai_assist" });
  });

  it("a policy block hands over and fails permanently (M18)", async () => {
    const fakes = makeFakes({
      generateObject: () => ({ status: "blocked", messageKey: "llm.blocked", dataClass: "gizli" }),
    });
    await expect(runIntake(fakes.deps, "PAY-101")).rejects.toMatchObject({ nonRetryable: true });
    expect(fakes.recorded.notifications.map((n) => n.event)).toContain("handover");
  });
});

describe("askClarification", () => {
  it("comments, journals, audits and labels — once, however often it is retried", async () => {
    const fakes = makeFakes();
    await askClarification(fakes.deps, "PAY-101", "hangi ortamda?");
    await askClarification(fakes.deps, "PAY-101", "hangi ortamda?");

    expect(fakes.recorded.comments).toHaveLength(1);
    expect(fakes.recorded.labels).toEqual([["maestro-bekliyor"]]);
    expect(fakes.journalStore.entries.filter((e) => e.kind === "clarification")).toHaveLength(1);
    expect((await fakes.chain.verify()).checked).toBe(1);
  });

  it("refuses to open an unanswerable wait", async () => {
    const fakes = makeFakes();
    await expect(askClarification(fakes.deps, "PAY-101", "   ")).rejects.toMatchObject({
      nonRetryable: true,
    });
    expect(fakes.recorded.comments).toEqual([]);
  });
});

describe("the snapshot the matcher reads is the adapter's, not a guess", () => {
  it("uses the components the work item actually carries", async () => {
    const ticket: TicketSnapshot = { ...SNAPSHOT, components: ["other"] };
    const fakes = makeFakes({ rules: [rule()], ticket });
    const fallback = makeFakes({
      rules: [rule()],
      ticket,
      generateObject: () => ({ status: "ok", value: { appId: "pay", confidence: 0.1 }, log: LOG }),
    });
    expect(pickRule([rule()], ticket)).toBeNull();
    expect(await matchApplication(fallback.deps, "PAY-101")).toBeNull();
    expect(fakes.recorded.llm).toEqual([]);
  });
});
