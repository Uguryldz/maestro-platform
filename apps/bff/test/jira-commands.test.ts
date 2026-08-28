import type { AuditEvent, TicketSnapshot } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import type { ListeningRuleRecord } from "../src/listening-store.js";
import { harness, type Harness } from "./helpers.js";
import { commentEvent, signed } from "./payloads.js";

const TICKET = "UGURPAY-123";
const TL_GROUPS = { "tech-leads": ["mert.demir"] };

async function deliver(h: Harness, body: string, author = "mert.demir", event?: "comment_updated") {
  const delivery = signed(
    commentEvent({
      ticket: TICKET,
      author,
      body,
      ...(event !== undefined ? { event, updated: "2026-08-09T09:06:00.000+0300" } : {}),
    }),
  );
  return h.app.inject({
    method: "POST",
    url: "/webhooks/jira",
    headers: delivery.headers,
    payload: delivery.payload,
  });
}

function gateEvents(events: readonly AuditEvent[]): AuditEvent[] {
  return events.filter((event) => event.action === "GATE_APPROVE" || event.action === "GATE_REJECT");
}

describe("Jira command path (M105)", () => {
  it("closes an open gate for a member of the owning group", async () => {
    const h = await harness({ groups: TL_GROUPS });
    h.runs.openGate(TICKET, "5");

    const response = await deliver(h, "/approve");

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ accepted: true, command: "approve" });

    const signal = h.runs.signals.at(-1);
    expect(signal?.name).toBe("gateDecision");
    expect(signal?.arg).toMatchObject({
      step: "5",
      decision: "approve",
      actorUserId: "mert.demir@ugurbank.local",
      actorGroup: "tech-leads",
      sodVerified: true,
      source: "jira",
    });
  });

  it("numbers the signature with its position in the audit chain (M33)", async () => {
    const h = await harness({ groups: TL_GROUPS });
    h.runs.openGate(TICKET, "5");

    await deliver(h, "/approve");

    const events = await h.auditStore.read();
    const approval = gateEvents(events).at(-1);
    expect(approval?.action).toBe("GATE_APPROVE");
    expect(h.runs.signals.at(-1)?.arg).toMatchObject({ signatureSeq: approval?.seq });
  });

  it('does NOT treat "/approve etmiyorum" as an approval (M105)', async () => {
    const h = await harness({ groups: TL_GROUPS });
    h.runs.openGate(TICKET, "5");

    const response = await deliver(h, "/approve etmiyorum");

    expect(response.json()).toEqual({ accepted: false, reason: "invalid_command" });
    expect(h.runs.signals).toHaveLength(0);
    expect(gateEvents(await h.auditStore.read())).toHaveLength(0);
    // The author is told why, rather than left believing they approved.
    expect(h.work.lastComment(TICKET)).toContain("/approve");
  });

  it("does not let trailing prose on a following line ride along with /approve", async () => {
    const h = await harness({ groups: TL_GROUPS });
    h.runs.openGate(TICKET, "5");

    const response = await deliver(h, "/approve\nama önce şu soruyu cevaplayın");

    expect(response.json()).toEqual({ accepted: false, reason: "invalid_command" });
    expect(h.runs.signals).toHaveLength(0);
  });

  it("refuses a gate decision from somebody outside the owning group (M32)", async () => {
    const h = await harness({ groups: { "tech-leads": ["baska.kisi"] } });
    h.runs.openGate(TICKET, "5");

    const response = await deliver(h, "/approve", "yetkisiz.kullanici");

    expect(response.json()).toEqual({
      accepted: false,
      command: "approve",
      reason: "not_member",
    });
    expect(h.runs.signals).toHaveLength(0);
    expect(gateEvents(await h.auditStore.read())).toHaveLength(0);
    expect(h.work.lastComment(TICKET)).toContain("tech-leads");
  });

  it("refuses a REJECT from somebody outside the owning group too", async () => {
    const h = await harness({ groups: { "tech-leads": ["baska.kisi"] } });
    h.runs.openGate(TICKET, "5");

    const response = await deliver(h, "/reject kapsam belirsiz", "yetkisiz.kullanici");

    expect(response.json()).toMatchObject({ accepted: false, reason: "not_member" });
    expect(h.runs.signals).toHaveLength(0);
  });

  it("ignores a command that arrived by editing a comment (M32 SoD)", async () => {
    const h = await harness({ groups: TL_GROUPS });
    h.runs.openGate(TICKET, "5");

    const response = await deliver(h, "/approve", "mert.demir", "comment_updated");

    expect(response.json()).toEqual({ accepted: false, reason: "not_intake" });
    expect(h.runs.signals).toHaveLength(0);
  });

  it("tells the author when /reject arrives without a reason", async () => {
    const h = await harness({ groups: TL_GROUPS });
    h.runs.openGate(TICKET, "5");

    const response = await deliver(h, "/reject");

    expect(response.json()).toEqual({ accepted: false, reason: "invalid_command" });
    expect(h.work.lastComment(TICKET)).toContain("/reject");
  });

  it("carries the rejection reason into the signal", async () => {
    const h = await harness({ groups: TL_GROUPS });
    h.runs.openGate(TICKET, "5");

    await deliver(h, "/reject kapsam çok geniş");

    expect(h.runs.signals.at(-1)?.arg).toMatchObject({
      decision: "reject",
      reason: "kapsam çok geniş",
    });
  });

  it("answers /approve on a ticket with no run", async () => {
    const h = await harness({ groups: TL_GROUPS });

    const response = await deliver(h, "/approve");

    expect(response.json()).toMatchObject({ accepted: false, reason: "no_run" });
    expect(h.work.lastComment(TICKET)).toContain(TICKET);
  });

  it("answers /approve when the run is not standing at an approval gate", async () => {
    const h = await harness({ groups: TL_GROUPS });
    h.runs.states.set(`maestro-${TICKET}`, {
      runId: `run-${TICKET}`,
      ticketKey: TICKET,
      step: "6a",
      status: "running",
      startedAt: "2026-08-09T09:00:00.000Z",
      updatedAt: "2026-08-09T09:00:00.000Z",
    });

    const response = await deliver(h, "/approve");

    expect(response.json()).toMatchObject({ accepted: false, reason: "no_open_gate" });
    expect(h.runs.signals).toHaveLength(0);
  });

  it("refuses a decision at the clarification wait, which is not an approval gate", async () => {
    const h = await harness({ groups: TL_GROUPS });
    h.runs.openGate(TICKET, "2b");

    const response = await deliver(h, "/approve");

    expect(response.json()).toMatchObject({ accepted: false, reason: "no_open_gate" });
  });

  it("reports the run state for /status", async () => {
    const h = await harness();
    h.runs.openGate(TICKET, "5");

    const response = await deliver(h, "/status");

    expect(response.json()).toMatchObject({ accepted: true, command: "status" });
    expect(h.work.lastComment(TICKET)).toContain(TICKET);
  });

  it("changes the work mode and records it", async () => {
    const h = await harness();
    h.runs.openGate(TICKET, "5");

    const response = await deliver(h, "/mode-change ai-assist");

    expect(response.json()).toMatchObject({ accepted: true });
    expect(h.runs.signals.at(-1)).toMatchObject({
      name: "modeChange",
      arg: { mode: "ai_assist", actor: "mert.demir@ugurbank.local" },
    });
    const events = await h.auditStore.read();
    expect(events.map((event) => event.action)).toContain("MODE_CHANGED");
  });

  it("maps /ai-takeover to human_lead", async () => {
    const h = await harness();
    h.runs.openGate(TICKET, "5");

    await deliver(h, "/ai-takeover");

    expect(h.runs.signals.at(-1)?.arg).toMatchObject({ mode: "human_lead" });
  });

  it("starts a run from /ai-start even in an opt-in project", async () => {
    const h = await harness({
      bindings: [
        {
          projectKey: "UGURPAY",
          active: true,
          triggerMode: "opt_in",
          appId: "ugurpay",
          mode: "full_auto",
          dataClass: "dahili",
        },
      ],
    });

    const response = await deliver(h, "/ai-start");

    expect(response.json()).toMatchObject({ accepted: true, command: "ai-start" });
    expect(h.runs.started).toHaveLength(1);
  });

  /**
   * Silence here is a DECISION, not an oversight (M102).
   *
   * One global webhook sees every project in the Jira instance. Answering on a
   * project nobody bound — even to refuse — would tell its author that Maestro
   * is watching a project it was never given. So `unbound` posts nothing, and
   * this test exists so a future "why is this silent?" does not turn a security
   * boundary into a bug report.
   */
  it("says NOTHING on a project nobody bound, so the platform is not disclosed", async () => {
    const h = await harness({ bindings: [] });

    const response = await deliver(h, "/ai-start");

    expect(response.json()).toMatchObject({ accepted: false, reason: "unbound" });
    expect(h.work.lastComment(TICKET) ?? "").toBe("");
  });

  it("records the application when /ai-assign names one", async () => {
    const h = await harness({
      bindings: [
        {
          projectKey: "UGURPAY",
          active: true,
          triggerMode: "opt_in",
          appId: null,
          mode: "full_auto",
          dataClass: "dahili",
        },
      ],
    });

    const response = await deliver(h, "/ai-assign ugurweb");

    expect(response.json()).toMatchObject({ accepted: true, command: "ai-assign" });
    expect(h.runs.started[0]).toMatchObject({ appId: "ugurweb" });
    const events = await h.auditStore.read();
    expect(events.map((event) => event.action)).toContain("ASSIGN_APP");
  });

  /**
   * `/ai-start` had the SAME defect Studio's Start button did, and for the same
   * reason: a comment delivery carries the comment, not the issue's fields, so
   * intake was handed a ticket key and nothing else. `flow-decision.ts` matches
   * on issue type and assignee, so the command matched no listening rule and
   * silently ran the deployment default — losing the rule's flow and, worse, its
   * status map, which is why a hand-started OPS ticket never moved on the board.
   *
   * Asserted through the intake seam (the engine's start input), not by spying
   * on the ticket read: that a snapshot was fetched is an implementation detail;
   * that the rule matched is the behaviour.
   */
  describe("a comment command classifies the ticket it was written on", () => {
    const RULE: ListeningRuleRecord = {
      ruleId: "lr_bot",
      projectKey: "UGURPAY",
      assigneeAccountId: "712020:maestro-bot",
      matchKind: "issuetype",
      matchValue: "Hata",
      flowType: "duzeltme",
      priority: 10,
      enabled: true,
      statusMap: { onStart: "Devam Ediyor", onDone: "Tamam" },
    };

    const SNAP: TicketSnapshot = {
      key: TICKET,
      projectKey: "UGURPAY",
      issueType: "Hata",
      summary: "Kredi limiti hatası",
      description: "",
      reporter: "can.ozturk",
      assignee: "712020:maestro-bot",
      components: [],
      labels: [],
      parentKey: null,
      createdAt: "2026-08-09T09:00:00.000Z",
      updatedAt: "2026-08-09T09:00:00.000Z",
    };

    /** The default is deliberately NOT the rule's flow, so the two are telling apart. */
    async function commandHarness(snapshot: TicketSnapshot | null = SNAP): Promise<Harness> {
      const h = await harness({
        listeningRules: [RULE],
        deps: { config: { actorDomain: "ugurbank.local", defaultFlow: "analiz" } },
      });
      if (snapshot !== null) h.work.putTicket(snapshot);
      return h;
    }

    it("runs /ai-start on the rule's flow and map, not the deployment default", async () => {
      const h = await commandHarness();

      const response = await deliver(h, "/ai-start");

      expect(response.json()).toMatchObject({ accepted: true, command: "ai-start" });
      const started = h.runs.started[0] as { flow?: unknown; statusMap?: unknown } | undefined;
      // Before the fix both of these were the default's: `analiz`, and no map.
      expect(started?.flow).toBe("duzeltme");
      expect(started?.statusMap).toEqual(RULE.statusMap);
    });

    it("classifies /ai-assign too — naming an application does not name the flow", async () => {
      const h = await commandHarness();

      const response = await deliver(h, "/ai-assign ugurweb");

      expect(response.json()).toMatchObject({ accepted: true, command: "ai-assign" });
      const started = h.runs.started[0] as { flow?: unknown; appId?: unknown } | undefined;
      expect(started?.appId).toBe("ugurweb");
      expect(started?.flow).toBe("duzeltme");
    });

    /**
     * A Jira that will not answer for the ticket must not cost the command. The
     * run still starts on the deployment default — exactly what `/ai-start` did
     * before it read the ticket at all — rather than the author's command
     * vanishing because a snapshot read failed.
     */
    it("still starts the run when the ticket read throws", async () => {
      const h = await commandHarness(null);

      const response = await deliver(h, "/ai-start");

      expect(response.json()).toMatchObject({ accepted: true, command: "ai-start" });
      expect(h.runs.started).toHaveLength(1);
      expect((h.runs.started[0] as { flow?: unknown }).flow).toBe("analiz");
    });
  });

  it("tells the author that /ai-explain has no workflow signal yet", async () => {
    const h = await harness();
    h.runs.openGate(TICKET, "5");

    const response = await deliver(h, "/ai-explain");

    expect(response.json()).toMatchObject({ accepted: false, reason: "unsupported" });
    expect(h.work.lastComment(TICKET)).toContain("/ai-explain");
  });

  it("tells the author when the command is not one Maestro knows", async () => {
    const h = await harness();

    const response = await deliver(h, "/onayla");

    expect(response.json()).toEqual({ accepted: false, reason: "invalid_command" });
    expect(h.app.maestro.counters.invalidCommands).toBe(1);
    expect(h.work.lastComment(TICKET)).toBeDefined();
  });
});
