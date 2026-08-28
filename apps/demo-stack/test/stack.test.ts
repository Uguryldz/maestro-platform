import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_PASSWORD } from "../src/seed/users.js";
import { auth, demoHarness, type DemoHarness } from "./harness.js";

/**
 * The stack comes up, and the parts of it that must be REAL are real:
 * authentication actually authenticates, roles actually gate, project scoping
 * actually scopes, and the confidential data-class filter actually withholds.
 *
 * These are the assertions that separate a demo from a mock-up. Seeded data is
 * fine; a seeded 200 is not.
 */

let h: DemoHarness;

beforeAll(async () => {
  h = await demoHarness();
});

afterAll(async () => {
  await h.app.close();
});

describe("the stack boots", () => {
  it("answers /healthz 200 without a credential", async () => {
    const response = await h.app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok" });
  });

  it("answers /readyz 200 — the in-memory engine and kill switch both respond", async () => {
    const response = await h.app.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ready",
      checks: { workflows: "ok", killswitch: "ok" },
    });
  });
});

describe("login is real", () => {
  it("refuses a wrong password", async () => {
    const response = await h.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "ayse.kaya", password: "wrong-password" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "invalid_credentials" });
  });

  it("refuses an unknown account with the SAME answer as a wrong password", async () => {
    const response = await h.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "nobody.here", password: DEMO_PASSWORD },
    });

    // Identical code and status: the demo must not become a way to enumerate
    // which of the seeded accounts exist.
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "invalid_credentials" });
  });

  it("issues a session for the right password, carrying the account's roles", async () => {
    const response = await h.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "mert.demir", password: DEMO_PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      token: string;
      user: { roles: string[]; username: string };
    };
    expect(body.token.length).toBeGreaterThan(20);
    expect(body.user.username).toBe("mert.demir");
    expect(body.user.roles).toContain("tech-lead");
  });

  it("refuses every guarded route without a token", async () => {
    const response = await h.app.inject({ method: "GET", url: "/studio/runs" });

    expect(response.statusCode).toBe(401);
  });
});

describe("roles are enforced, not decorative", () => {
  it("gives a viewer 403 on the admin runner fleet", async () => {
    const token = await h.login("selin.aydin", DEMO_PASSWORD);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/runners",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "role_required" });
  });

  it("gives a viewer 403 on the audit trail, and the auditor 200", async () => {
    const viewer = await h.login("selin.aydin", DEMO_PASSWORD);
    const auditor = await h.login("hulya.arslan", DEMO_PASSWORD);

    const refused = await h.app.inject({
      method: "GET",
      url: "/studio/audit",
      headers: auth(viewer),
    });
    const allowed = await h.app.inject({
      method: "GET",
      url: "/studio/audit",
      headers: auth(auditor),
    });

    expect(refused.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(200);
    expect((allowed.json() as { items: unknown[] }).items.length).toBeGreaterThan(0);
  });

  it("lets an admin read the fleet the viewer was refused", async () => {
    const token = await h.login("ayse.kaya", DEMO_PASSWORD);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/runners",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: { runnerId: string; state: string }[] };
    expect(body.items.some((runner) => runner.state === "unreachable")).toBe(true);
  });
});

describe("project scoping is enforced", () => {
  it("refuses a developer a ticket outside their groups", async () => {
    // baran.tekin is in maestro-ugurdesk and maestro-ugurmob, not maestro-ugurpay.
    const token = await h.login("baran.tekin", DEMO_PASSWORD);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/runs/UGURPAY-501",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "project_access" });
  });

  it("shows that developer only their own projects in the list", async () => {
    const token = await h.login("baran.tekin", DEMO_PASSWORD);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/runs",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: { ticketKey: string }[] };
    expect(body.items.length).toBeGreaterThan(0);
    for (const row of body.items) {
      expect(row.ticketKey).toMatch(/^(UGURDESK|UGURMOB)-/);
    }
  });

  it("lets a tech lead see across projects", async () => {
    const token = await h.login("mert.demir", DEMO_PASSWORD);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/runs",
      headers: auth(token),
    });

    const body = response.json() as { items: { ticketKey: string }[] };
    const projects = new Set(body.items.map((row) => row.ticketKey.split("-")[0]));
    expect(projects.size).toBeGreaterThan(1);
  });
});

describe("the confidential filter withholds, and says so", () => {
  it("hides gizli documents from a viewer and reports the count", async () => {
    const token = await h.login("selin.aydin", DEMO_PASSWORD);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/knowledge?q=limit",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      items: { dataClass: string }[];
      withheld: number;
    };
    expect(body.items.every((doc) => doc.dataClass !== "gizli")).toBe(true);
    expect(body.withheld).toBeGreaterThan(0);
  });

  it("shows the same document to an account with the clearance", async () => {
    const token = await h.login("ayse.kaya", DEMO_PASSWORD);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/knowledge?q=limit",
      headers: auth(token),
    });

    const body = response.json() as { items: { dataClass: string }[]; withheld: number };
    expect(body.items.some((doc) => doc.dataClass === "gizli")).toBe(true);
    expect(body.withheld).toBe(0);
  });
});
