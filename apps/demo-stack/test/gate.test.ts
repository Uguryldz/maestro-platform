import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEMO_PASSWORD } from "../src/seed/users.js";
import { auth, demoHarness, type DemoHarness } from "./harness.js";

/**
 * Approving a gate in the demo CHANGES something.
 *
 * This is the assertion the whole exercise turns on. A demo where the approve
 * button returns 200 and leaves the run exactly where it was is a demo of a
 * button, not of a platform — and it is indistinguishable from the real thing
 * until somebody looks at the second screen. So: the run must move, the trail
 * must gain a record, and the wrong person must be refused.
 *
 * A fresh stack per test, because these mutate state on purpose.
 */

let h: DemoHarness;

beforeEach(async () => {
  h = await demoHarness();
});

afterEach(async () => {
  await h.app.close();
});

/** UGURPAY-501 sits at step 12 (PR approval), owned by `tech-leads`. */
const AT_PR_GATE = "UGURPAY-501";

describe("a gate decision moves the run", () => {
  it("advances the run past the gate when its owner approves", async () => {
    const before = h.runs.stateOf(AT_PR_GATE);
    expect(before).toMatchObject({ step: "12", status: "gate" });

    const token = await h.login("mert.demir", DEMO_PASSWORD);
    const response = await h.app.inject({
      method: "POST",
      url: `/runs/${AT_PR_GATE}/signals/gateDecision`,
      headers: auth(token),
      payload: { decision: "approve" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ accepted: true, step: "12" });

    // The actual point: the state moved off the gate.
    const after = h.runs.stateOf(AT_PR_GATE);
    expect(after?.step).not.toBe("12");
    expect(after?.status).not.toBe("gate");
    expect(after?.updatedAt).not.toBe(before?.updatedAt);
  });

  it("delivers the decision as a signal carrying the session's identity", async () => {
    const token = await h.login("mert.demir", DEMO_PASSWORD);
    await h.app.inject({
      method: "POST",
      url: `/runs/${AT_PR_GATE}/signals/gateDecision`,
      headers: auth(token),
      payload: { decision: "approve" },
    });

    const signal = h.runs.delivered.find((entry) => entry.name === "gateDecision");
    expect(signal).toBeDefined();
    expect(signal?.arg).toMatchObject({
      step: "12",
      decision: "approve",
      // The approver is the SESSION's identity, never the body's.
      actorUserId: "mert.demir@ugurbank.local",
      actorGroup: "tech-leads",
      source: "studio",
    });
  });

  it("records the approval in the hash chain, and the chain still verifies", async () => {
    const auditor = await h.login("hulya.arslan", DEMO_PASSWORD);
    const before = await h.app.inject({
      method: "GET",
      url: "/studio/audit",
      headers: auth(auditor),
    });
    const beforeCount = (before.json() as { items: unknown[] }).items.length;

    const token = await h.login("mert.demir", DEMO_PASSWORD);
    await h.app.inject({
      method: "POST",
      url: `/runs/${AT_PR_GATE}/signals/gateDecision`,
      headers: auth(token),
      payload: { decision: "approve" },
    });

    const after = await h.app.inject({
      method: "GET",
      url: "/studio/audit",
      headers: auth(auditor),
    });
    const rows = (after.json() as { items: { action: string; subject: string }[] }).items;

    expect(rows.length).toBe(beforeCount + 1);
    expect(rows[0]).toMatchObject({ action: "GATE_APPROVE", subject: AT_PR_GATE });

    const verification = await h.app.inject({
      method: "GET",
      url: "/studio/audit/verification",
      headers: auth(auditor),
    });
    expect(verification.json()).toMatchObject({ ok: true });
  });

  it("sends a rejected run back to engineering, and demands a reason", async () => {
    const token = await h.login("mert.demir", DEMO_PASSWORD);

    const noReason = await h.app.inject({
      method: "POST",
      url: `/runs/${AT_PR_GATE}/signals/gateDecision`,
      headers: auth(token),
      payload: { decision: "reject" },
    });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json()).toMatchObject({ error: "reject_needs_reason" });
    // Refused means refused: nothing moved.
    expect(h.runs.stateOf(AT_PR_GATE)).toMatchObject({ step: "12", status: "gate" });

    const withReason = await h.app.inject({
      method: "POST",
      url: `/runs/${AT_PR_GATE}/signals/gateDecision`,
      headers: auth(token),
      payload: { decision: "reject", reason: "Testler yetersiz, kapsam düştü." },
    });
    expect(withReason.statusCode).toBe(200);
    expect(h.runs.stateOf(AT_PR_GATE)).toMatchObject({ step: "6a", status: "running" });
  });
});

describe("a gate decision is refused when it should be", () => {
  it("refuses somebody who is not in the gate's owning group", async () => {
    // deniz.yilmaz is QA and can see UGURPAY, but the PR gate belongs to
    // tech-leads — a session is not a licence to approve.
    const token = await h.login("deniz.yilmaz", DEMO_PASSWORD);

    const response = await h.app.inject({
      method: "POST",
      url: `/runs/${AT_PR_GATE}/signals/gateDecision`,
      headers: auth(token),
      payload: { decision: "approve" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "not_gate_owner" });
    expect(h.runs.stateOf(AT_PR_GATE)).toMatchObject({ step: "12", status: "gate" });
  });

  it("refuses a decision on a run that is not at a gate", async () => {
    const token = await h.login("mert.demir", DEMO_PASSWORD);

    // UGURWEB-88 is mid-engineering, not waiting on anybody.
    const response = await h.app.inject({
      method: "POST",
      url: "/runs/UGURWEB-88/signals/gateDecision",
      headers: auth(token),
      payload: { decision: "approve" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "no_open_gate" });
  });

  it("refuses a decision on the clarification wait, which is not an approval", async () => {
    const token = await h.login("mert.demir", DEMO_PASSWORD);

    // UGURPAY-712 reports `gate` at step 2b — a human wait, not a gate to close.
    const response = await h.app.inject({
      method: "POST",
      url: "/runs/UGURPAY-712/signals/gateDecision",
      headers: auth(token),
      payload: { decision: "approve" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "no_open_gate" });
  });

  it("refuses a decision for a project the caller cannot see", async () => {
    const token = await h.login("baran.tekin", DEMO_PASSWORD);

    const response = await h.app.inject({
      method: "POST",
      url: `/runs/${AT_PR_GATE}/signals/gateDecision`,
      headers: auth(token),
      payload: { decision: "approve" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "project_access" });
    expect(h.runs.delivered).toHaveLength(0);
  });

  it("refuses a signal name that is not on Studio's allow-list", async () => {
    const token = await h.login("mert.demir", DEMO_PASSWORD);

    const response = await h.app.inject({
      method: "POST",
      url: `/runs/${AT_PR_GATE}/signals/ciResult`,
      headers: auth(token),
      payload: { status: "succeeded" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "signal_not_allowed" });
  });
});

describe("answering a clarification moves the waiting run", () => {
  it("advances UGURPAY-712 off the 2b wait", async () => {
    expect(h.runs.stateOf("UGURPAY-712")).toMatchObject({ step: "2b", status: "gate" });

    const token = await h.login("can.ozturk", DEMO_PASSWORD);
    const response = await h.app.inject({
      method: "POST",
      url: "/runs/UGURPAY-712/signals/clarificationAnswered",
      headers: auth(token),
      payload: { text: "İade tutarı kuruş bazında yuvarlanmalı; eşik 0,005 TL." },
    });

    expect(response.statusCode).toBe(202);
    expect(h.runs.stateOf("UGURPAY-712")).toMatchObject({ step: "3o", status: "running" });
  });
});

describe("fail-closed paths really refuse", () => {
  it("refuses an unsigned Jira webhook rather than accepting it", async () => {
    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: { "content-type": "application/json" },
      payload: { webhookEvent: "jira:issue_created" },
    });

    // Whatever the code, it must not be a 2xx: an unauthenticated write path is
    // the exact hole the single data door exists to close.
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(h.runs.delivered).toHaveLength(0);
  });

  it("refuses an unauthenticated ADO build result", async () => {
    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/ado",
      headers: { "content-type": "application/json" },
      payload: { eventType: "ms.vss-pipelines.run-state-changed-event" },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });
});
