import { describe, expect, it } from "vitest";
import { auth, harness, type Harness } from "./helpers.js";
import { issueEvent, signed } from "./payloads.js";

async function admin(h: Harness): Promise<string> {
  await h.addUser({ username: "ayse.kaya", roles: ["admin"] });
  return h.login("ayse.kaya");
}

function flip(h: Harness, token: string, level: string, reason = "olay müdahalesi") {
  return h.app.inject({
    method: "POST",
    url: "/killswitch",
    headers: auth(token),
    payload: { level, reason },
  });
}

async function deliverNewTicket(h: Harness, ticket: string) {
  const delivery = signed(issueEvent({ ticket }));
  return h.app.inject({
    method: "POST",
    url: "/webhooks/jira",
    headers: delivery.headers,
    payload: delivery.payload,
  });
}

describe("POST /killswitch (M58)", () => {
  it("refuses a caller without the admin role", async () => {
    const h = await harness();
    await h.addUser({ username: "sade.kullanici" });
    const token = await h.login("sade.kullanici");

    const response = await flip(h, token, "intake_only");

    expect(response.statusCode).toBe(403);
    expect((await h.killSwitch.get()).level).toBe("off");
  });

  it("refuses a delegated AI token even when the human is an admin (M101)", async () => {
    const h = await harness();
    await h.addUser({ username: "ayse.kaya", roles: ["admin"] });
    const token = await h.delegatedToken("ayse.kaya");

    const response = await flip(h, token, "all");

    expect(response.statusCode).toBe(403);
    expect((await h.killSwitch.get()).level).toBe("off");
  });

  it("records the operation in the audit chain", async () => {
    const h = await harness();
    const token = await admin(h);

    const response = await flip(h, token, "intake_only");

    expect(response.statusCode).toBe(200);
    expect((await h.killSwitch.get()).level).toBe("intake_only");
    const events = await h.auditStore.read();
    const recorded = events.filter((event) => event.action === "KILL_SWITCH");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ actor: "ayse.kaya@ugurbank.local" });
  });

  it("refuses new intake while the switch is on", async () => {
    const h = await harness();
    const token = await admin(h);
    await flip(h, token, "intake_only");

    const response = await deliverNewTicket(h, "UGURPAY-500");

    expect(response.json()).toEqual({ accepted: false, reason: "kill_switch" });
    expect(h.runs.started).toHaveLength(0);
    expect(h.app.maestro.counters.droppedKillSwitch).toBe(1);
    // Silence would look like an outage; the ticket is told why (M14).
    expect(h.work.lastComment("UGURPAY-500")).toContain("intake_only");
  });

  it("refuses new intake at the `all` level too", async () => {
    const h = await harness();
    const token = await admin(h);
    await flip(h, token, "all");

    const response = await deliverNewTicket(h, "UGURPAY-501");

    expect(response.json()).toEqual({ accepted: false, reason: "kill_switch" });
  });

  it("takes intake again once the switch is turned off", async () => {
    const h = await harness();
    const token = await admin(h);
    await flip(h, token, "intake_only");
    await flip(h, token, "off", "olay kapandı");

    const response = await deliverNewTicket(h, "UGURPAY-502");

    expect(response.json()).toMatchObject({ accepted: true });
  });

  it("stops running work only at the `all` level", async () => {
    const h = await harness();
    const token = await admin(h);
    h.runs.openGate("UGURPAY-1", "5");
    h.runs.openGate("UGURPAY-2", "5");

    const intakeOnly = await flip(h, token, "intake_only");
    expect((intakeOnly.json() as { stopped: string[] }).stopped).toEqual([]);
    expect(h.runs.signals).toHaveLength(0);

    const all = await flip(h, token, "all");
    expect((all.json() as { stopped: string[] }).stopped).toHaveLength(2);
    expect(h.runs.signals.every((signal) => signal.name === "killSwitch")).toBe(true);
  });

  it("demands a reason", async () => {
    const h = await harness();
    const token = await admin(h);

    const response = await h.app.inject({
      method: "POST",
      url: "/killswitch",
      headers: auth(token),
      payload: { level: "all" },
    });

    expect(response.statusCode).toBe(400);
    expect((await h.killSwitch.get()).level).toBe("off");
  });

  it("reports the current state to any authenticated caller", async () => {
    const h = await harness();
    const token = await admin(h);
    await flip(h, token, "intake_only", "bakım penceresi");

    const response = await h.app.inject({ method: "GET", url: "/killswitch", headers: auth(token) });

    expect(response.json()).toMatchObject({ level: "intake_only", reason: "bakım penceresi" });
  });
});
