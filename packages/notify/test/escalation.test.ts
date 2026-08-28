import { describe, expect, it } from "vitest";
import { NotifyRecipientError } from "../src/errors.js";
import { EscalationLadder, escalationDueAt, planEscalation, resolveSteps } from "../src/escalation.js";

const OPENED = "2026-08-03T09:00:00+03:00"; // Monday 09:00 Istanbul
const plus = (hours: number): string => new Date(Date.parse(OPENED) + hours * 3_600_000).toISOString();

/**
 * A stored `escalation.ladder` value, in the shape `@maestro/db` persists it.
 * It is a FIXTURE, not a default — this package deliberately ships no default
 * ladder (M71: settings live in the DB). It is deliberately one step richer
 * than the shipped seed (two channels share the 72h threshold) so the "several
 * steps come due at once" path is covered; the shipped seed itself is parsed
 * with this same schema in `packages/db/test/notify-params.test.ts`.
 */
const SEEDED_LADDER = {
  steps: [
    { id: "reminder-24h", afterHours: 24, channel: "jira", event: "gate_reminder" },
    { id: "escalation-72h-teams", afterHours: 72, channel: "teams", event: "escalation" },
    { id: "escalation-72h-mail", afterHours: 72, channel: "smtp", event: "escalation" },
    {
      id: "delegate-7d",
      afterHours: 168,
      channel: "teams",
      event: "escalation",
      action: "delegate",
      messageKey: "notify.delegated",
    },
  ],
  businessHoursOnly: false,
};

const LADDER = EscalationLadder.parse(SEEDED_LADDER);

describe("escalation ladder (M88)", () => {
  it("parses the persisted `escalation.ladder` parameter into the exact steps stored", () => {
    const parsed = EscalationLadder.parse(SEEDED_LADDER);
    expect(parsed.steps.map((step) => [step.id, step.afterHours, step.channel, step.action])).toEqual([
      ["reminder-24h", 24, "jira", "notify"],
      ["escalation-72h-teams", 72, "teams", "notify"],
      ["escalation-72h-mail", 72, "smtp", "notify"],
      ["delegate-7d", 168, "teams", "delegate"],
    ]);
    expect(parsed.steps[3]?.messageKey).toBe("notify.delegated");
    expect(parsed.businessHoursOnly).toBe(false);
    // `action` is the only field the schema fills in; nothing else is invented.
    expect(parsed.steps[0]).toEqual({ ...SEEDED_LADDER.steps[0], action: "notify" });
  });

  it("fires nothing before the first threshold", () => {
    const decision = escalationDueAt(LADDER, { openedAt: OPENED, now: plus(23.9) });
    expect(decision.due).toEqual([]);
    expect(decision.next?.step.channel).toBe("jira");
    expect(decision.next?.dueAt).toBe(new Date(plus(24)).toISOString());
  });

  it("fires exactly the crossed steps at t", () => {
    const at72 = escalationDueAt(LADDER, { openedAt: OPENED, now: plus(72) });
    expect(at72.due.map((step) => step.stepId)).toEqual([
      "reminder-24h",
      "escalation-72h-teams",
      "escalation-72h-mail",
    ]);
    expect(at72.next?.step.action).toBe("delegate");
  });

  it("never fires a step twice", () => {
    const fired = ["reminder-24h", "escalation-72h-teams"];
    const decision = escalationDueAt(LADDER, { openedAt: OPENED, now: plus(100), firedStepIds: fired });
    expect(decision.due.map((step) => step.stepId)).toEqual(["escalation-72h-mail"]);
  });

  it("is deterministic: the same arguments give the same answer", () => {
    const query = { openedAt: OPENED, now: plus(80), firedStepIds: ["reminder-24h"] };
    expect(escalationDueAt(LADDER, query)).toEqual(escalationDueAt(LADDER, query));
  });

  it("keeps ids stable when a step is inserted at the top", () => {
    const grown = EscalationLadder.parse({
      steps: [{ id: "nudge-1h", afterHours: 1, channel: "slack", event: "gate_reminder" }, ...LADDER.steps],
    });
    expect(resolveSteps(grown).map((step) => step.stepId)).toEqual([
      "nudge-1h",
      "reminder-24h",
      "escalation-72h-teams",
      "escalation-72h-mail",
      "delegate-7d",
    ]);
  });

  it("counts business hours only when the parameter says so", () => {
    // Friday 17:00 + 24 wall-clock hours is Saturday: nothing is due yet in
    // business mode, while wall-clock mode fires the 24h step.
    const friday = "2026-08-07T17:00:00+03:00";
    const saturday = "2026-08-08T17:00:00+03:00";
    const business = EscalationLadder.parse({ ...SEEDED_LADDER, businessHoursOnly: true });
    expect(escalationDueAt(business, { openedAt: friday, now: saturday }).due).toEqual([]);
    expect(escalationDueAt(LADDER, { openedAt: friday, now: saturday }).due).toHaveLength(1);
  });

  it("reports the next due instant on the business calendar", () => {
    const business = EscalationLadder.parse({
      steps: [{ id: "reminder-4h", afterHours: 4, channel: "jira", event: "gate_reminder" }],
      businessHoursOnly: true,
    });
    const decision = escalationDueAt(business, {
      openedAt: "2026-08-07T17:00:00+03:00", // Friday 17:00 -> 1h left that day
      now: "2026-08-07T18:00:00+03:00",
    });
    expect(decision.next?.dueAt).toBe("2026-08-10T09:00:00.000Z"); // Monday 12:00 Istanbul
  });

  it("rejects a `now` that precedes the anchor", () => {
    expect(() => escalationDueAt(LADDER, { openedAt: OPENED, now: plus(-1) })).toThrow(/before openedAt/);
  });

  it("rejects a ladder with no steps", () => {
    expect(() => EscalationLadder.parse({ steps: [] })).toThrow();
  });
});

describe("escalation plan (M88 + M104)", () => {
  const ctx = {
    openedAt: OPENED,
    now: plus(72),
    locale: "tr" as const,
    params: { ticket: "UGURPAY-501", gate: "5", days: "3", delegate: "Mert Demir" },
    recipients: () => ["ops"],
  };

  it("emits one notification per due step, with catalog keys and no text", () => {
    const plan = planEscalation(LADDER, ctx);
    expect(plan.notifications.map((notification) => [notification.channel, notification.messageKey])).toEqual([
      ["jira", "notify.gate_reminder"],
      ["teams", "notify.escalation"],
      ["smtp", "notify.escalation"],
    ]);
    expect(plan.notifications[0]?.at).toBe(ctx.now);
    expect(plan.notifications[0]?.to).toEqual(["ops"]);
  });

  it("honours a per-step audience and message key", () => {
    const ladder = EscalationLadder.parse({
      steps: [
        {
          id: "handover-1h",
          afterHours: 1,
          channel: "smtp",
          event: "handover",
          to: ["deputy@bank.local"],
          messageKey: "notify.handover",
        },
      ],
    });
    const plan = planEscalation(ladder, { ...ctx, params: { ticket: "UGURPAY-501", reason: "timeout" } });
    expect(plan.notifications[0]?.to).toEqual(["deputy@bank.local"]);
    expect(plan.notifications[0]?.messageKey).toBe("notify.handover");
  });

  it("lists the delegation steps so the caller reassigns the gate", () => {
    const plan = planEscalation(LADDER, { ...ctx, now: plus(168) });
    expect(plan.delegations.map((step) => step.stepId)).toEqual(["delegate-7d"]);
    expect(plan.notifications.at(-1)?.messageKey).toBe("notify.delegated");
  });

  it("refuses a step that resolves to nobody", () => {
    expect(() => planEscalation(LADDER, { ...ctx, recipients: () => [] })).toThrow(NotifyRecipientError);
  });
});
