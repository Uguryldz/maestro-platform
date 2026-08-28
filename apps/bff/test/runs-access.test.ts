import { describe, expect, it } from "vitest";
import { projectGroupFor } from "../src/routes/runs.js";
import { auth, harness, type Harness } from "./helpers.js";

const TICKET = "UGURPAY-123";
/** The group that membership of the UGURPAY project is read from (M86). */
const PROJECT_GROUP = projectGroupFor("UGURPAY");

/**
 * M86: Studio is open to everyone, but everyone sees "their own work". A
 * session is not a licence to drive somebody else's ticket — the verifier drove
 * a stranger's run to full_auto and answered a requirement on their behalf with
 * a roleless intern account.
 */
describe("run access is scoped to the project (M86)", () => {
  const OUTSIDER = "stajyer";

  async function outsider(h: Harness): Promise<string> {
    await h.addUser({ username: OUTSIDER, roles: [], groups: [] });
    return h.login(OUTSIDER);
  }

  it("refuses to put a stranger's ticket into full_auto", async () => {
    const h = await harness();
    h.runs.openGate(TICKET, "5");
    const token = await outsider(h);

    const response = await h.app.inject({
      method: "POST",
      url: `/runs/${TICKET}/signals/modeChange`,
      headers: auth(token),
      payload: { mode: "full_auto" },
    });

    expect(response.statusCode).toBe(403);
    expect(h.runs.signals).toHaveLength(0);
    const events = await h.auditStore.read();
    expect(events.map((event) => event.action)).not.toContain("MODE_CHANGED");
  });

  it("refuses to answer a requirement on a stranger's ticket", async () => {
    const h = await harness();
    h.runs.openGate(TICKET, "2b");
    const token = await outsider(h);

    const response = await h.app.inject({
      method: "POST",
      url: `/runs/${TICKET}/signals/clarificationAnswered`,
      headers: auth(token),
      payload: { text: "Herkese açık olsun." },
    });

    expect(response.statusCode).toBe(403);
    expect(h.runs.signals).toHaveLength(0);
  });

  it("refuses to read a stranger's run", async () => {
    const h = await harness();
    h.runs.openGate(TICKET, "5");
    const token = await outsider(h);

    const response = await h.app.inject({
      method: "GET",
      url: `/runs/${TICKET}`,
      headers: auth(token),
    });

    expect(response.statusCode).toBe(403);
  });

  /** Not-a-member and no-such-run must look the same, or /runs/:t is a ticket oracle. */
  it("answers 403 alike for an unknown ticket in a project the caller cannot see", async () => {
    const h = await harness();
    const token = await outsider(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/runs/UGURPAY-999",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(403);
  });

  it("lets a project member through", async () => {
    const h = await harness();
    h.runs.openGate(TICKET, "5");
    await h.addUser({ username: "uye.kisi", groups: [PROJECT_GROUP] });
    const token = await h.login("uye.kisi");

    const response = await h.app.inject({
      method: "GET",
      url: `/runs/${TICKET}`,
      headers: auth(token),
    });

    expect(response.statusCode).toBe(200);
  });

  it("lets an admin through without per-project membership", async () => {
    const h = await harness();
    h.runs.openGate(TICKET, "5");
    await h.addUser({ username: "yonetici", roles: ["admin"], groups: [] });
    const token = await h.login("yonetici");

    const response = await h.app.inject({
      method: "GET",
      url: `/runs/${TICKET}`,
      headers: auth(token),
    });

    expect(response.statusCode).toBe(200);
  });

  it("does not list a stranger's runs", async () => {
    const h = await harness();
    h.runs.openGate(TICKET, "5");
    const token = await outsider(h);

    const response = await h.app.inject({ method: "GET", url: "/runs", headers: auth(token) });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { runs: unknown[] }).runs).toHaveLength(0);
  });

  it("lists the runs of a project the caller belongs to", async () => {
    const h = await harness();
    h.runs.openGate(TICKET, "5");
    await h.addUser({ username: "uye.kisi", groups: [PROJECT_GROUP] });
    const token = await h.login("uye.kisi");

    const response = await h.app.inject({ method: "GET", url: "/runs", headers: auth(token) });

    expect((response.json() as { runs: unknown[] }).runs).toHaveLength(1);
  });
});
