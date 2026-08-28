import type { CiResultSignal } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import { harness } from "./helpers.js";

const AUTHORIZATION = "Basic bWFlc3Ryby1zdmM6c2VjcmV0";

const BUILD: CiResultSignal = {
  ticketKey: "UGURPAY-123",
  adoProject: "Payments",
  adoRepo: "ugurpay",
  prId: 4711,
  buildId: 90210,
  status: "succeeded",
  finishedAt: "2026-08-09T09:30:00.000Z",
};

const BODY = JSON.stringify({ eventType: "build.complete", resource: { id: 90210 } });

describe("POST /webhooks/ado", () => {
  it("refuses an unauthenticated delivery (M15/M106)", async () => {
    const h = await harness({ adoAuthorization: AUTHORIZATION, ciSignal: BUILD });
    h.runs.openGate("UGURPAY-123", "10b");

    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/ado",
      headers: { "content-type": "application/json" },
      payload: BODY,
    });

    expect(response.statusCode).toBe(401);
    expect(h.runs.signals).toHaveLength(0);
  });

  it("refuses a delivery whose shared secret does not match", async () => {
    const h = await harness({ adoAuthorization: AUTHORIZATION, ciSignal: BUILD });

    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/ado",
      headers: { "content-type": "application/json", authorization: "Basic d3Jvbmc=" },
      payload: BODY,
    });

    expect(response.statusCode).toBe(401);
  });

  it("refuses an unauthenticated delivery before complaining about its syntax", async () => {
    const h = await harness({ adoAuthorization: AUTHORIZATION, ciSignal: BUILD });

    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/ado",
      headers: { "content-type": "application/json" },
      payload: "not json either",
    });

    expect(response.statusCode).toBe(401);
  });

  it("delivers an authenticated build result as a signal", async () => {
    const h = await harness({ adoAuthorization: AUTHORIZATION, ciSignal: BUILD });
    h.runs.openGate("UGURPAY-123", "10b");

    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/ado",
      headers: { "content-type": "application/json", authorization: AUTHORIZATION },
      payload: BODY,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ accepted: true, workflowId: "maestro-UGURPAY-123" });
    expect(h.runs.signals.at(-1)).toMatchObject({ name: "ciResult", arg: BUILD });

    const events = await h.auditStore.read();
    expect(events.map((event) => event.action)).toContain("CI_RESULT");
  });

  it("never starts a run from a build result", async () => {
    const h = await harness({ adoAuthorization: AUTHORIZATION, ciSignal: BUILD });

    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/ado",
      headers: { "content-type": "application/json", authorization: AUTHORIZATION },
      payload: BODY,
    });

    expect(response.json()).toEqual({ accepted: false, reason: "no_run" });
    expect(h.runs.started).toHaveLength(0);
  });

  it("acknowledges an authenticated event that is not a build result", async () => {
    const h = await harness({ adoAuthorization: AUTHORIZATION, ciSignal: null });

    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/ado",
      headers: { "content-type": "application/json", authorization: AUTHORIZATION },
      payload: JSON.stringify({ eventType: "git.push" }),
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: false, reason: "ignored" });
    expect(h.runs.signals).toHaveLength(0);
  });
});
