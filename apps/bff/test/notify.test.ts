import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { auth, harness, type Harness } from "./helpers.js";

/**
 * The reminder ladder and channel routing (M45/M71/M88).
 *
 * The screen's promise is that no rung auto-rejects: a pause is not a decision
 * (M29), so the ladder ends by telling a human rather than by timing a gate
 * out. The tests below check the projection that carries that promise, and the
 * refusal that keeps an unseeded ladder from rendering as "nothing to chase".
 */

const LADDER = {
  steps: [
    { id: "reminder-24h", afterHours: 24, channel: "jira", event: "gate_reminder" },
    { id: "escalation-72h", afterHours: 72, channel: "teams", event: "escalation" },
    {
      id: "delegate-7d",
      afterHours: 168,
      channel: "smtp",
      event: "escalation",
      action: "delegate",
      messageKey: "notify.delegated",
      to: ["tl-primary@ugurbank.local", "tl-backup@ugurbank.local"],
    },
  ],
  businessHoursOnly: false,
};

const ROUTING = {
  default: ["teams"],
  byEvent: { gate_reminder: ["jira"], escalation: ["teams", "smtp"] },
};

async function admin(h: Harness): Promise<string> {
  await h.addUser({ username: "ayse.kaya", roles: ["admin"] });
  return h.login("ayse.kaya");
}

function get(h: Harness, token: string): Promise<LightMyRequestResponse> {
  return h.app.inject({ method: "GET", url: "/notify", headers: auth(token) });
}

interface NotifyBody {
  ladder: { afterHours: number; channels: string[]; kind: string }[];
  delegations: { role: string; primary: string; backup: string | null }[];
  waiting: { ticketKey: string; step: string; waitingHours: number }[];
  routing: { default: string[]; byEvent: Record<string, string[]> };
}

async function seed(h: Harness, ladder: unknown = LADDER, routing: unknown = ROUTING): Promise<void> {
  await h.params.apply({
    key: "escalation.ladder",
    scopeRef: null,
    value: ladder,
    version: 1,
    changedBy: "installer@ugurbank.local",
    approvedBy: null,
    at: "2026-08-01T09:00:00.000Z",
  });
  await h.params.apply({
    key: "notify.routing",
    scopeRef: null,
    value: routing,
    version: 1,
    changedBy: "installer@ugurbank.local",
    approvedBy: null,
    at: "2026-08-01T09:00:00.000Z",
  });
}

describe("GET /notify (M45/M88)", () => {
  it("returns the ladder, the delegations and what is waiting", async () => {
    const h = await harness();
    const token = await admin(h);
    await seed(h);

    const response = await get(h, token);

    expect(response.statusCode).toBe(200);
    const body = response.json() as NotifyBody;
    expect(body.ladder).toHaveLength(3);
    expect(body.ladder.map((step) => step.afterHours)).toEqual([24, 72, 168]);
  });

  it("shows the channels the ROUTING map sends each rung to, not just the step's own", async () => {
    const h = await harness();
    const token = await admin(h);
    await seed(h);

    const body = (await get(h, token)).json() as NotifyBody;

    // The 72h rung is an `escalation`, which the routing map sends to teams and
    // smtp. Showing the step's single `channel` would show a plan the platform
    // does not follow.
    expect(body.ladder[1]?.channels).toEqual(["smtp", "teams"]);
  });

  it("marks the delegating rung as a delegation rather than another reminder", async () => {
    const h = await harness();
    const token = await admin(h);
    await seed(h);

    const body = (await get(h, token)).json() as NotifyBody;

    // `action: "delegate"` is what makes the 7-day rung a handover instead of a
    // third shout — the deputy is told the gate landed on their desk.
    expect(body.ladder[2]?.kind).toBe("delegate");
  });

  it("ends the ladder with a report to a human, never an auto-reject (M29)", async () => {
    const h = await harness();
    const token = await admin(h);
    // A ladder whose last rung is a plain notify: the end of the escalation.
    await seed(h, {
      steps: [
        { id: "reminder-24h", afterHours: 24, channel: "jira", event: "gate_reminder" },
        { id: "final-72h", afterHours: 72, channel: "teams", event: "escalation" },
      ],
      businessHoursOnly: false,
    });

    const body = (await get(h, token)).json() as NotifyBody;

    // The last rung is a REPORT. Nothing in the shape can express "reject", and
    // an operator who assumed an unanswered gate resolves itself would stop
    // chasing it.
    expect(body.ladder.map((step) => step.kind)).toEqual(["notify", "report"]);
  });

  /**
   * Two steps at the same hour must not become two identical rungs.
   *
   * The shipped ladder has a 72h escalation and a reminder that rides with it;
   * once both are resolved through the routing map they render as the same row
   * — same hour, same kind, same channels. The screen keys its rungs on
   * `kind-afterHours`, so emitting both threw a React duplicate-key error and
   * drew two identical arrows. Found by opening the page against the seeded
   * database, which is why it is pinned here.
   */
  it("merges rungs that would render identically instead of duplicating them", async () => {
    const h = await harness();
    const token = await admin(h);
    await seed(h, {
      steps: [
        { id: "reminder-72h", afterHours: 72, channel: "teams", event: "escalation" },
        { id: "escalation-72h", afterHours: 72, channel: "smtp", event: "escalation" },
        { id: "final-168h", afterHours: 168, channel: "teams", event: "escalation" },
      ],
      businessHoursOnly: false,
    });

    const body = (await get(h, token)).json() as NotifyBody;

    expect(body.ladder).toHaveLength(2);
    // The React key the screen builds must be unique across the rungs.
    const keys = body.ladder.map((step) => `${step.kind}-${String(step.afterHours)}`);
    expect(new Set(keys).size).toBe(keys.length);
    // Merged, not dropped: both channels still go out at 72 hours.
    expect(body.ladder[0]?.channels).toEqual(["smtp", "teams"]);
  });

  it("reports the delegate rung's audience as the delegation chain", async () => {
    const h = await harness();
    const token = await admin(h);
    await seed(h);

    const body = (await get(h, token)).json() as NotifyBody;

    expect(body.delegations[0]).toMatchObject({
      primary: "tl-primary@ugurbank.local",
      backup: "tl-backup@ugurbank.local",
      lastResort: null,
    });
  });

  it("refuses rather than showing an empty ladder when the parameter is not seeded", async () => {
    const h = await harness();
    const token = await admin(h);

    const response = await get(h, token);

    // A ladder with no rungs and one that was never seeded look identical on
    // screen, and the second means no gate in the bank is being chased.
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: string; details: { key: string } };
    expect(body.error).toBe("param_not_seeded");
    expect(body.details.key).toBe("escalation.ladder");
  });

  it("refuses a stored ladder it cannot parse rather than half-rendering it", async () => {
    const h = await harness();
    const token = await admin(h);
    // A step missing its `event`: an escalation that would never fire.
    await seed(h, { steps: [{ id: "broken", afterHours: 24, channel: "jira" }] });

    const response = await get(h, token);

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toBe("param_unusable");
  });

  /**
   * The field NAMES, pinned.
   *
   * The screens are not typed against the BFF's interfaces, so a rename on
   * either side compiles cleanly and crashes the page in a browser. One
   * assertion per field `Notify.tsx` actually reads.
   */
  it("uses the field names the notify screen reads", async () => {
    const h = await harness();
    const token = await admin(h);
    await seed(h);
    h.read.gates.open({
      ticketKey: "UGURPAY-1042",
      runId: "run-1",
      // `StepId` is the numbered workflow step, not a name — step 3 is the
      // analysis gate.
      step: "3",
      ownerGroup: "tech-leads",
      openedAt: "2026-08-05T09:00:00.000Z",
      delegatedTo: "tl-backup@ugurbank.local",
    });

    const body = (await get(h, token)).json() as {
      ladder: Record<string, unknown>[];
      delegations: Record<string, unknown>[];
      waiting: Record<string, unknown>[];
      routing: Record<string, unknown>;
      ladderRaw: { steps: Record<string, unknown>[]; businessHoursOnly: unknown };
    };

    for (const field of ["afterHours", "channels", "kind"]) {
      expect(body.ladder[0]).toHaveProperty(field);
    }
    for (const field of ["role", "primary", "backup", "lastResort"]) {
      expect(body.delegations[0]).toHaveProperty(field);
    }
    for (const field of ["ticketKey", "step", "waitingHours", "lastActionKey"]) {
      expect(body.waiting[0]).toHaveProperty(field);
    }
    // The routing map and the RAW ladder round-trip to the editor. The raw
    // ladder must carry the per-step `id` — a projected rung has none, and the
    // editor needs it to change a threshold without re-escalating open gates.
    expect(body.routing).toHaveProperty("default");
    expect(body.ladderRaw).toHaveProperty("businessHoursOnly");
    for (const field of ["id", "afterHours", "channel", "event"]) {
      expect(body.ladderRaw.steps[0]).toHaveProperty(field);
    }
  });

  it("refuses a developer (M86)", async () => {
    const h = await harness();
    await h.addUser({ username: "can.yilmaz", roles: ["developer"] });
    const token = await h.login("can.yilmaz");
    await seed(h);

    expect((await get(h, token)).statusCode).toBe(403);
  });
});

describe("PUT /notify", () => {
  it("applies a ladder change and bumps the parameter version", async () => {
    const h = await harness();
    const token = await admin(h);
    await seed(h);

    const response = await h.app.inject({
      method: "PUT",
      url: "/notify",
      headers: auth(token),
      payload: {
        ladder: {
          ...LADDER,
          steps: [{ id: "reminder-12h", afterHours: 12, channel: "jira", event: "gate_reminder" }],
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const values = await h.params.values();
    const ladderRows = values.filter((value) => value.key === "escalation.ladder");
    // Version 2, not an edit of version 1: "which value was live when" has to
    // stay answerable (M71).
    expect(ladderRows.map((row) => row.version)).toEqual([1, 2]);
  });

  it("saves a Teams webhook and reads it back MASKED, never in full", async () => {
    const h = await harness();
    const token = await admin(h);
    await seed(h);
    const secretUrl = "https://outlook.office.com/webhook/verylongsecret-abc123";

    const put = await h.app.inject({
      method: "PUT",
      url: "/notify",
      headers: auth(token),
      payload: { teamsWebhook: secretUrl },
    });
    expect(put.statusCode).toBe(200);

    const body = (await get(h, token)).json() as { teamsWebhookMask: string };
    // The read returns only a mask — the last few chars — never the full URL.
    expect(body.teamsWebhookMask).toBe("…abc123");
    expect(JSON.stringify(body)).not.toContain(secretUrl);
    expect(JSON.stringify(body)).not.toContain("verylongsecret");
  });

  it("clears the Teams webhook when an empty string is saved", async () => {
    const h = await harness();
    const token = await admin(h);
    await seed(h);
    await h.app.inject({
      method: "PUT",
      url: "/notify",
      headers: auth(token),
      payload: { teamsWebhook: "https://outlook.office.com/webhook/x123456" },
    });
    await h.app.inject({
      method: "PUT",
      url: "/notify",
      headers: auth(token),
      payload: { teamsWebhook: "" },
    });
    const body = (await get(h, token)).json() as { teamsWebhookMask: string };
    expect(body.teamsWebhookMask).toBe("");
  });

  it("keeps a step's id across an edit so open gates do not re-escalate", async () => {
    const h = await harness();
    const token = await admin(h);
    await seed(h);

    await h.app.inject({
      method: "PUT",
      url: "/notify",
      headers: auth(token),
      payload: {
        // Same id, lowered threshold — the exact edit that would re-escalate
        // every open gate if the id were derived from the content.
        ladder: {
          ...LADDER,
          steps: [{ id: "reminder-24h", afterHours: 12, channel: "jira", event: "gate_reminder" }],
        },
      },
    });

    const body = (await get(h, token)).json() as NotifyBody;
    expect(body.ladder[0]?.afterHours).toBe(12);
  });

  it("refuses a ladder with no steps", async () => {
    const h = await harness();
    const token = await admin(h);
    await seed(h);

    const response = await h.app.inject({
      method: "PUT",
      url: "/notify",
      headers: auth(token),
      payload: { ladder: { steps: [], businessHoursOnly: false } },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toBe("invalid_notify_body");
  });

  it("refuses a body that changes nothing", async () => {
    const h = await harness();
    const token = await admin(h);
    await seed(h);

    const response = await h.app.inject({
      method: "PUT",
      url: "/notify",
      headers: auth(token),
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });

  it("refuses the write while the kill switch is on (M58)", async () => {
    const h = await harness();
    const token = await admin(h);
    await seed(h);
    await h.killSwitch.set({
      level: "all",
      actor: "ayse.kaya@ugurbank.local",
      reason: "olay",
      at: "2026-08-09T10:00:00.000Z",
    });

    const response = await h.app.inject({
      method: "PUT",
      url: "/notify",
      headers: auth(token),
      payload: { routing: ROUTING },
    });

    expect(response.statusCode).toBe(409);
  });
});
