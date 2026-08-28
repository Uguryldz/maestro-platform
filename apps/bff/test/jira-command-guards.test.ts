import type { AuditEvent } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import { harness, UGURPAY_BINDING, type Harness } from "./helpers.js";
import { commentEvent, signed } from "./payloads.js";

/**
 * Hardening of the Jira command path: the checks that decide whether a command
 * is answered AT ALL, as opposed to `jira-commands.test.ts`, which covers what
 * a command does once it is. Three separate refusals live here — an author the
 * audit trail cannot attribute (M33), a project Maestro was never bound to
 * (M102), and the kill switch (M58).
 */

const TICKET = "UGURPAY-123";
const TL_GROUPS = { "tech-leads": ["mert.demir"] };

async function deliver(h: Harness, body: string, author = "mert.demir") {
  const delivery = signed(commentEvent({ ticket: TICKET, author, body }));
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

describe("an unparseable Jira author never 500s (M14/M33)", () => {
  const BAD_AUTHORS = [
    ["a space", "a b"],
    ["a non-ASCII login", "kullanıcı"],
    ["an empty string", ""],
    ["only whitespace", "   "],
    ["an @ with no domain", "ayse@"],
    ["a bare @", "@"],
    ["something already qualified but malformed", "a b@corp.local"],
  ] as const;

  it.each(BAD_AUTHORS)("answers 202 for %s", async (_label, author) => {
    const h = await harness({ groups: TL_GROUPS });
    h.runs.openGate(TICKET, "5");

    const response = await deliver(h, "/approve", author);

    expect(response.statusCode).toBe(202);
    expect(h.runs.signals).toHaveLength(0);
    expect(gateEvents(await h.auditStore.read())).toHaveLength(0);
  });

  it("tells the author their account could not be identified", async () => {
    const h = await harness({ groups: TL_GROUPS });
    h.runs.openGate(TICKET, "5");

    await deliver(h, "/approve", "a b");

    // A catalog sentence, not a raw key and not a stack trace.
    expect(h.work.lastComment(TICKET)).toBeDefined();
    expect(h.work.lastComment(TICKET)).not.toContain("Error");
  });

  it("stays silent about an invalid author on an UNBOUND project", async () => {
    const h = await harness({ groups: TL_GROUPS });
    const delivery = signed(commentEvent({ ticket: "GIZLI-1", author: "a b", body: "/approve" }));

    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    expect(response.statusCode).toBe(202);
    expect(h.work.comments).toHaveLength(0);
  });

  it("still accepts a normal bare Jira login", async () => {
    const h = await harness({ groups: TL_GROUPS });
    h.runs.openGate(TICKET, "5");

    const response = await deliver(h, "/approve", "mert.demir");

    expect(response.json()).toMatchObject({ accepted: true });
  });
});

/**
 * M102: one global webhook delivers every project's traffic. A project that was
 * never bound, or was paused, is dropped WITHOUT A TRACE — answering at all
 * tells whoever typed the command that Maestro is watching that project, and
 * `/status` would hand them the run's step and status on top of it.
 */
describe("commands on an unbound project (M102)", () => {
  const UNBOUND_TICKET = "GIZLI-1";

  async function deliverTo(h: Harness, ticket: string, body: string, author = "mert.demir") {
    const delivery = signed(commentEvent({ ticket, author, body }));
    return h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });
  }

  const COMMANDS = [
    "/approve",
    "/reject kapsam belirsiz",
    "/status",
    "/ai-takeover",
    "/mode-change ai-assist",
    "/ai-start",
    "/ai-assign ugurweb",
    "/ai-explain",
  ];

  it.each(COMMANDS)("drops %s silently and writes no comment", async (command) => {
    const h = await harness({ groups: TL_GROUPS });
    h.runs.openGate(UNBOUND_TICKET, "5");

    const response = await deliverTo(h, UNBOUND_TICKET, command);

    expect(response.statusCode).toBe(202);
    expect(h.work.comments).toHaveLength(0);
    expect(h.runs.signals).toHaveLength(0);
    expect(gateEvents(await h.auditStore.read())).toHaveLength(0);
  });

  it("does not leak the run's step or status through /status", async () => {
    const h = await harness();
    h.runs.openGate(UNBOUND_TICKET, "5");

    await deliverTo(h, UNBOUND_TICKET, "/status");

    expect(h.work.lastComment(UNBOUND_TICKET)).toBeUndefined();
  });

  it("drops commands on a project that is bound but PAUSED", async () => {
    const h = await harness({
      groups: TL_GROUPS,
      bindings: [{ ...UGURPAY_BINDING, active: false }],
    });
    h.runs.openGate(TICKET, "5");

    const response = await deliverTo(h, TICKET, "/approve");

    expect(response.statusCode).toBe(202);
    expect(h.work.comments).toHaveLength(0);
    expect(h.runs.signals).toHaveLength(0);
  });

  it("counts the drop rather than losing it", async () => {
    const h = await harness({ groups: TL_GROUPS });

    await deliverTo(h, UNBOUND_TICKET, "/approve");

    expect(h.app.maestro.counters.droppedUnbound).toBe(1);
  });

  /**
   * The invalid-command reply is the same leak wearing a different hat: a typo
   * on an unbound project must not be corrected either, or "/aprove" becomes a
   * probe for which projects Maestro watches.
   */
  it("does not answer a MALFORMED command on an unbound project", async () => {
    const h = await harness({ groups: TL_GROUPS });

    const response = await deliverTo(h, UNBOUND_TICKET, "/approve etmiyorum");

    expect(response.statusCode).toBe(202);
    expect(h.work.comments).toHaveLength(0);
  });

  it("does not answer an unknown command on an unbound project", async () => {
    const h = await harness({ groups: TL_GROUPS });

    await deliverTo(h, UNBOUND_TICKET, "/onayla");

    expect(h.work.comments).toHaveLength(0);
  });

  it("still corrects a malformed command on a BOUND project", async () => {
    const h = await harness({ groups: TL_GROUPS });

    await deliverTo(h, TICKET, "/approve etmiyorum");

    expect(h.work.lastComment(TICKET)).toContain("/approve");
  });

  it("still answers a command on a BOUND project", async () => {
    const h = await harness({ groups: TL_GROUPS });
    h.runs.openGate(TICKET, "5");

    const response = await deliverTo(h, TICKET, "/approve");

    expect(response.json()).toMatchObject({ accepted: true, command: "approve" });
  });
});

/**
 * M58: `all` stops the platform. Gate decisions stay open — a switch that
 * stranded every pending approval would make the recovery worse than the
 * incident — but everything that asks Maestro to DO something waits.
 */
describe("commands while the kill switch is on (M58)", () => {
  it("refuses /mode-change at level all", async () => {
    const h = await harness({ groups: TL_GROUPS });
    h.runs.openGate(TICKET, "5");
    await h.killSwitch.set({ level: "all", actor: "admin@ugurbank.local", reason: "olay", at: "2026-08-09T09:00:00.000Z" });

    const response = await deliver(h, "/mode-change ai-assist");

    expect(response.json()).toMatchObject({ accepted: false, reason: "kill_switch" });
    expect(h.runs.signals).toHaveLength(0);
  });

  it("refuses /ai-takeover at level all", async () => {
    const h = await harness({ groups: TL_GROUPS });
    h.runs.openGate(TICKET, "5");
    await h.killSwitch.set({ level: "all", actor: "admin@ugurbank.local", reason: "olay", at: "2026-08-09T09:00:00.000Z" });

    const response = await deliver(h, "/ai-takeover");

    expect(response.json()).toMatchObject({ accepted: false, reason: "kill_switch" });
    expect(h.runs.signals).toHaveLength(0);
  });

  it("KEEPS accepting an open gate decision at level all", async () => {
    const h = await harness({ groups: TL_GROUPS });
    h.runs.openGate(TICKET, "5");
    await h.killSwitch.set({ level: "all", actor: "admin@ugurbank.local", reason: "olay", at: "2026-08-09T09:00:00.000Z" });

    const response = await deliver(h, "/approve");

    expect(response.json()).toMatchObject({ accepted: true, command: "approve" });
    expect(h.runs.signals.at(-1)?.name).toBe("gateDecision");
  });

  it("keeps accepting /reject at level all", async () => {
    const h = await harness({ groups: TL_GROUPS });
    h.runs.openGate(TICKET, "5");
    await h.killSwitch.set({ level: "all", actor: "admin@ugurbank.local", reason: "olay", at: "2026-08-09T09:00:00.000Z" });

    const response = await deliver(h, "/reject kapsam belirsiz");

    expect(response.json()).toMatchObject({ accepted: true, command: "reject" });
  });

  it("lets /mode-change through at intake_only, which only stops NEW work", async () => {
    const h = await harness({ groups: TL_GROUPS });
    h.runs.openGate(TICKET, "5");
    await h.killSwitch.set({
      level: "intake_only",
      actor: "admin@ugurbank.local",
      reason: "olay",
      at: "2026-08-09T09:00:00.000Z",
    });

    const response = await deliver(h, "/mode-change ai-assist");

    expect(response.json()).toMatchObject({ accepted: true });
  });
});
