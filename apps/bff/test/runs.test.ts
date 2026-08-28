import { describe, expect, it } from "vitest";
import { projectGroupFor } from "../src/routes/runs.js";
import { auth, harness } from "./helpers.js";

const TICKET = "UGURPAY-123";
/** The group that membership of the UGURPAY project is read from (M86). */
const PROJECT_GROUP = projectGroupFor("UGURPAY");

describe("REST /runs", () => {
  it("lists runs for an authenticated caller", async () => {
    const h = await harness();
    await h.addUser({ username: "ayse.kaya", groups: [PROJECT_GROUP] });
    h.runs.openGate(TICKET, "5");
    const token = await h.login("ayse.kaya");

    const response = await h.app.inject({ method: "GET", url: "/runs", headers: auth(token) });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { runs: unknown[] }).runs).toHaveLength(1);
  });

  it("reads the run state through the workflow query", async () => {
    const h = await harness();
    await h.addUser({ username: "ayse.kaya", groups: [PROJECT_GROUP] });
    h.runs.openGate(TICKET, "5");
    const token = await h.login("ayse.kaya");

    const response = await h.app.inject({
      method: "GET",
      url: `/runs/${TICKET}`,
      headers: auth(token),
    });

    expect(response.json()).toMatchObject({ ticketKey: TICKET, step: "5", status: "gate" });
  });

  it("404s for a ticket Maestro is not running", async () => {
    const h = await harness();
    await h.addUser({ username: "ayse.kaya", groups: [PROJECT_GROUP] });
    const token = await h.login("ayse.kaya");

    const response = await h.app.inject({
      method: "GET",
      url: "/runs/UGURPAY-999",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(404);
  });
});

describe("POST /runs/:ticket/signals/:name", () => {
  it("closes a gate from Studio for a member of the owning group", async () => {
    const h = await harness({ groups: { "tech-leads": ["ayse.kaya"] } });
    await h.addUser({ username: "ayse.kaya", groups: [PROJECT_GROUP] });
    h.runs.openGate(TICKET, "5");
    const token = await h.login("ayse.kaya");

    const response = await h.app.inject({
      method: "POST",
      url: `/runs/${TICKET}/signals/gateDecision`,
      headers: auth(token),
      payload: { decision: "approve" },
    });

    expect(response.statusCode).toBe(200);
    expect(h.runs.signals.at(-1)?.arg).toMatchObject({
      step: "5",
      decision: "approve",
      actorUserId: "ayse.kaya@ugurbank.local",
      source: "studio",
    });
  });

  it("refuses a gate decision from outside the owning group", async () => {
    const h = await harness({ groups: { "tech-leads": ["baskasi"] } });
    await h.addUser({ username: "ayse.kaya", groups: [PROJECT_GROUP] });
    h.runs.openGate(TICKET, "5");
    const token = await h.login("ayse.kaya");

    const response = await h.app.inject({
      method: "POST",
      url: `/runs/${TICKET}/signals/gateDecision`,
      headers: auth(token),
      payload: { decision: "approve" },
    });

    expect(response.statusCode).toBe(403);
    expect(h.runs.signals).toHaveLength(0);
  });

  it("refuses a gate decision from a delegated AI token (M32/M101)", async () => {
    const h = await harness({ groups: { "tech-leads": ["ayse.kaya"] } });
    await h.addUser({ username: "ayse.kaya", groups: [PROJECT_GROUP] });
    h.runs.openGate(TICKET, "5");
    const token = await h.delegatedToken("ayse.kaya");

    const response = await h.app.inject({
      method: "POST",
      url: `/runs/${TICKET}/signals/gateDecision`,
      headers: auth(token),
      payload: { decision: "approve" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "human_channel_only" });
    expect(h.runs.signals).toHaveLength(0);
  });

  it("takes the approver from the session, never from the body", async () => {
    const h = await harness({ groups: { "tech-leads": ["ayse.kaya"] } });
    await h.addUser({ username: "ayse.kaya", groups: [PROJECT_GROUP] });
    h.runs.openGate(TICKET, "5");
    const token = await h.login("ayse.kaya");

    await h.app.inject({
      method: "POST",
      url: `/runs/${TICKET}/signals/gateDecision`,
      headers: auth(token),
      payload: { decision: "approve", actorUserId: "patron@ugurbank.local", signatureSeq: 999 },
    });

    expect(h.runs.signals.at(-1)?.arg).toMatchObject({
      actorUserId: "ayse.kaya@ugurbank.local",
      signatureSeq: 1,
    });
  });

  it("demands a reason for a rejection", async () => {
    const h = await harness({ groups: { "tech-leads": ["ayse.kaya"] } });
    await h.addUser({ username: "ayse.kaya", groups: [PROJECT_GROUP] });
    h.runs.openGate(TICKET, "5");
    const token = await h.login("ayse.kaya");

    const response = await h.app.inject({
      method: "POST",
      url: `/runs/${TICKET}/signals/gateDecision`,
      headers: auth(token),
      payload: { decision: "reject" },
    });

    expect(response.statusCode).toBe(400);
    expect(h.runs.signals).toHaveLength(0);
  });

  it("will not forward a CI result, however well authenticated the caller is (M106)", async () => {
    const h = await harness();
    await h.addUser({ username: "ayse.kaya", roles: ["admin"] });
    h.runs.openGate(TICKET, "10b");
    const token = await h.login("ayse.kaya");

    const response = await h.app.inject({
      method: "POST",
      url: `/runs/${TICKET}/signals/ciResult`,
      headers: auth(token),
      payload: { ticketKey: TICKET, prId: 1, buildId: 1, status: "succeeded", finishedAt: "2026-08-09T09:00:00.000Z" },
    });

    expect(response.statusCode).toBe(403);
    expect(h.runs.signals).toHaveLength(0);
  });

  it("will not forward a kill switch through the generic signal route (M58)", async () => {
    const h = await harness();
    await h.addUser({ username: "ayse.kaya", roles: ["admin"] });
    h.runs.openGate(TICKET, "5");
    const token = await h.login("ayse.kaya");

    const response = await h.app.inject({
      method: "POST",
      url: `/runs/${TICKET}/signals/killSwitch`,
      headers: auth(token),
      payload: { level: "all", actor: "x", reason: "y", at: "2026-08-09T09:00:00.000Z" },
    });

    expect(response.statusCode).toBe(403);
  });

  it("delivers a clarification answer and records it", async () => {
    const h = await harness();
    await h.addUser({ username: "reporter.kisi", groups: [PROJECT_GROUP] });
    h.runs.openGate(TICKET, "2b");
    const token = await h.login("reporter.kisi");

    const response = await h.app.inject({
      method: "POST",
      url: `/runs/${TICKET}/signals/clarificationAnswered`,
      headers: auth(token),
      payload: { text: "Evet, yalnız bireysel müşteriler." },
    });

    expect(response.statusCode).toBe(202);
    expect(h.runs.signals.at(-1)).toMatchObject({ name: "clarificationAnswered" });
    const events = await h.auditStore.read();
    expect(events.map((event) => event.action)).toContain("CLARIFICATION_ANSWERED");
  });

  it("404s when the signal has no run to reach", async () => {
    const h = await harness();
    await h.addUser({ username: "ayse.kaya", groups: [PROJECT_GROUP] });
    const token = await h.login("ayse.kaya");

    const response = await h.app.inject({
      method: "POST",
      url: "/runs/UGURPAY-999/signals/modeChange",
      headers: auth(token),
      payload: { mode: "ai_assist" },
    });

    expect(response.statusCode).toBe(404);
  });
});
