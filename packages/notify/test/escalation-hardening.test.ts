import { describe, expect, it } from "vitest";
import { NotifyRouting } from "../src/config.js";
import { EscalationLadder, escalationDueAt, planEscalation, resolveSteps } from "../src/escalation.js";

/**
 * Ladder regressions: a step id that moved when an operator edited a threshold,
 * a plan that produced notifications the drivers would later refuse, a
 * delegation announced with the wrong sentence, and free-text routing keys.
 */

const OPENED = "2026-08-03T09:00:00+03:00"; // Monday 09:00 Istanbul
const plus = (hours: number): string => new Date(Date.parse(OPENED) + hours * 3_600_000).toISOString();

const ladderOf = (steps: unknown[]): EscalationLadder => EscalationLadder.parse({ steps });

describe("B13 — a step id survives an edit in Studio", () => {
  it("does not re-fire a sent step when its threshold is lowered", () => {
    const before = ladderOf([{ id: "gate-escalation", afterHours: 72, channel: "teams", event: "escalation" }]);
    const after = ladderOf([{ id: "gate-escalation", afterHours: 48, channel: "teams", event: "escalation" }]);

    const fired = escalationDueAt(before, { openedAt: OPENED, now: plus(73) }).due.map((step) => step.stepId);
    expect(fired).toEqual(["gate-escalation"]);

    // Same step, new threshold: it has already been sent, so it stays sent.
    const afterEdit = escalationDueAt(after, { openedAt: OPENED, now: plus(80), firedStepIds: fired });
    expect(afterEdit.due).toEqual([]);
  });

  it("requires an explicit id — a content-derived one moves when content moves", () => {
    expect(() => ladderOf([{ afterHours: 24, channel: "jira", event: "gate_reminder" }])).toThrow();
  });

  it("refuses a ladder with two steps sharing an id", () => {
    const ladder = ladderOf([
      { id: "dup", afterHours: 24, channel: "jira", event: "gate_reminder" },
      { id: "dup", afterHours: 72, channel: "teams", event: "escalation" },
    ]);
    expect(() => resolveSteps(ladder)).toThrow(/duplicate/i);
  });
});

describe("B15 — a plan only emits notifications the drivers accept", () => {
  const ctx = {
    openedAt: OPENED,
    now: plus(72),
    locale: "tr" as const,
    params: { ticket: "UGURPAY-501", gate: "5", days: "3" },
    recipients: () => ["ops"],
  };
  const ladder = ladderOf([{ id: "escalate", afterHours: 24, channel: "teams", event: "escalation" }]);

  it("refuses a date-only `now` instead of building an invalid notification", () => {
    expect(() => planEscalation(ladder, { ...ctx, now: "2026-08-02" })).toThrow(/now/);
  });

  it("refuses a date-only `openedAt`", () => {
    expect(() => escalationDueAt(ladder, { openedAt: "2026-08-02", now: plus(72) })).toThrow(/openedAt/);
  });

  it("refuses an instant without an offset (the frozen contract requires one)", () => {
    expect(() => escalationDueAt(ladder, { openedAt: "2026-08-03T09:00:00", now: plus(72) })).toThrow(/openedAt/);
  });

  it("emits notifications that satisfy the frozen contract", () => {
    const plan = planEscalation(ladder, ctx);
    expect(plan.notifications[0]?.at).toBe(ctx.now);
    expect(plan.notifications[0]?.params).toEqual(ctx.params);
  });
});

describe("B5 — a delegation says it was delegated", () => {
  it("defaults a delegate step to the `notify.delegated` catalog key", () => {
    const ladder = ladderOf([
      { id: "delegate-7d", afterHours: 168, channel: "teams", event: "escalation", action: "delegate" },
    ]);
    const plan = planEscalation(ladder, {
      openedAt: OPENED,
      now: plus(168),
      locale: "tr",
      params: { ticket: "UGURPAY-501", days: "7", delegate: "Mert Demir" },
      recipients: () => ["ops"],
    });
    expect(plan.notifications[0]?.messageKey).toBe("notify.delegated");
    expect(plan.delegations.map((step) => step.stepId)).toEqual(["delegate-7d"]);
  });
});

describe("B14 — routing keys are contract event keys, not free text", () => {
  it("refuses a mistyped event key instead of silently using the default", () => {
    expect(() => NotifyRouting.parse({ byEvent: { kill_swich: ["teams"] } })).toThrow();
  });

  it("refuses a channel the contract does not define", () => {
    expect(() => NotifyRouting.parse({ byEvent: { kill_switch: ["telegram"] } })).toThrow();
  });

  it("accepts a partial map of real event keys", () => {
    const routing = NotifyRouting.parse({ default: ["teams"], byEvent: { runner_health: ["slack"] } });
    expect(routing.byEvent.runner_health).toEqual(["slack"]);
  });
});
