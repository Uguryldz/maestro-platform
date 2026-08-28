import { describe, expect, it } from "vitest";
import { CONFIDENTIAL_GROUP } from "../src/knowledge-policy.js";
import { auth } from "./helpers.js";
import {
  AT,
  CALL,
  PUBLIC_DOC,
  SCAN,
  SECRET_DOC,
  TICKET,
  adminToken,
  memberToken,
  outsiderToken,
  studioHarness,
} from "./studio-fixtures.js";

describe("GET /studio/apps", () => {
  it("refuses an unauthenticated caller", async () => {
    const h = await studioHarness();
    expect((await h.app.inject({ method: "GET", url: "/studio/apps" })).statusCode).toBe(401);
  });

  it("returns the registry to any session", async () => {
    const h = await studioHarness();
    const token = await outsiderToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/apps", headers: auth(token) });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: { appId: string; adoRepo: string; platform: string }[] };
    expect(body.items[0]).toMatchObject({ appId: "ugurpay", adoRepo: "ugurpay", platform: "linux-node" });
  });

  it("404s an application that is not registered", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/apps/yok-boyle-bir-uygulama",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(404);
  });

  it("rejects an app id the contract would not accept", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/apps/NOT_AN_APP_ID",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("GET /studio/apps/:appId/repo-card", () => {
  it("returns the stored card", async () => {
    const h = await studioHarness();
    h.read.apps.putRepoCard({
      appId: "ugurpay",
      modules: [{ name: "limit", path: "src/limit", summary: "Kredi limiti hesaplama" }],
      generatedFromSha: "abc1234",
      version: 2,
      updatedAt: AT,
    });
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/apps/ugurpay/repo-card",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { modules: { name: string }[]; version: number };
    expect(body.version).toBe(2);
    expect(body.modules[0]?.name).toBe("limit");
  });

  /**
   * M100: an application onboarded this morning has no card. Inventing an empty
   * one would let an analysis claim it checked a repository it never read.
   */
  it("404s rather than inventing an empty card", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/apps/ugurpay/repo-card",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "no_repo_card" });
  });
});

/**
 * M18/M63. The classification boundary is the reason this endpoint exists at
 * all rather than Studio querying an index directly.
 */
describe("GET /studio/knowledge", () => {
  it("refuses an unauthenticated caller", async () => {
    const h = await studioHarness();
    expect((await h.app.inject({ method: "GET", url: "/studio/knowledge?q=analiz" })).statusCode).toBe(401);
  });

  it("requires a query rather than dumping the index", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/knowledge",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns the documents a plain session may read", async () => {
    const h = await studioHarness();
    h.read.knowledge.put(PUBLIC_DOC);
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/knowledge?q=analiz",
      headers: auth(token),
    });

    const body = response.json() as { items: { id: string; source: string }[]; withheld: number };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.source).toBe("rules/analiz-sablonu.md");
    expect(body.withheld).toBe(0);
  });

  it("withholds a gizli document from a session without the clearance", async () => {
    const h = await studioHarness();
    h.read.knowledge.put(PUBLIC_DOC);
    h.read.knowledge.put(SECRET_DOC);
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/knowledge?q=analiz",
      headers: auth(token),
    });

    const body = response.json() as { items: { id: string }[]; withheld: number };
    expect(body.items.map((doc) => doc.id)).toEqual(["kb-1"]);
    // Counted rather than silently dropped: a short list teaches a user the
    // knowledge base lacks something it has.
    expect(body.withheld).toBe(1);
  });

  it("shows a gizli document to a cleared session", async () => {
    const h = await studioHarness();
    h.read.knowledge.put(SECRET_DOC);
    await h.addUser({ username: "yetkili", groups: [CONFIDENTIAL_GROUP] });
    const token = await h.login("yetkili");

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/knowledge?q=analiz",
      headers: auth(token),
    });

    const body = response.json() as { items: { id: string }[]; withheld: number };
    expect(body.items.map((doc) => doc.id)).toEqual(["kb-2"]);
    expect(body.withheld).toBe(0);
  });

  /**
   * The rule the packet brief names explicitly: an unlabelled document is
   * `gizli`. A store that forgot to set the field must not become a leak.
   */
  it("treats an unlabelled document as gizli", async () => {
    const h = await studioHarness();
    h.read.knowledge.put({ ...PUBLIC_DOC, id: "kb-3", dataClass: undefined as never });
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/knowledge?q=analiz",
      headers: auth(token),
    });

    const body = response.json() as { items: unknown[]; withheld: number };
    expect(body.items).toHaveLength(0);
    expect(body.withheld).toBe(1);
  });
});

describe("GET /studio/scans", () => {
  it("does not show a stranger the findings of a project they cannot see", async () => {
    const h = await studioHarness();
    h.read.scans.put(SCAN);
    const token = await outsiderToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/scans", headers: auth(token) });

    expect((response.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  it("returns the finding with its file and rule to a project member", async () => {
    const h = await studioHarness();
    h.read.scans.put(SCAN);
    const token = await memberToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/scans", headers: auth(token) });

    const body = response.json() as {
      items: { ticketKey: string; outcome: string; finding: { ruleId: string; file: string; severity: string } }[];
    };
    expect(body.items[0]?.ticketKey).toBe(TICKET);
    expect(body.items[0]?.outcome).toBe("fail");
    expect(body.items[0]?.finding).toMatchObject({ ruleId: "sql-concat", file: "src/export.ts", severity: "medium" });
  });
});

describe("GET /studio/cost", () => {
  it("refuses a caller without an operator role", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/cost", headers: auth(token) });

    expect(response.statusCode).toBe(403);
  });

  it("returns the gateway call log to an admin", async () => {
    const h = await studioHarness();
    h.read.cost.put(CALL);
    const token = await adminToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/cost", headers: auth(token) });

    const body = response.json() as { items: { model: string; driver: string; usd: number }[] };
    expect(body.items[0]).toMatchObject({ model: "claude-opus-5", driver: "anthropic-direct", usd: 0.42 });
  });
});

describe("GET /studio/users/:username", () => {
  it("refuses a caller who is not an admin", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/users/uye.kisi",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(403);
  });

  it("returns roles and groups but never password material", async () => {
    const h = await studioHarness();
    await h.addUser({ username: "ayse.kaya", roles: ["tech-lead"], groups: ["tech-leads"] });
    const token = await adminToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/users/ayse.kaya",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ username: "ayse.kaya", roles: ["tech-lead"], groups: ["tech-leads"], active: true });
    expect(Object.keys(body)).not.toContain("passwordHash");
  });

  it("404s an unknown account", async () => {
    const h = await studioHarness();
    const token = await adminToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/users/kimse.yok",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(404);
  });
});

describe("GET /studio/users", () => {
  it("refuses a caller who is not an admin", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/users", headers: auth(token) });

    expect(response.statusCode).toBe(403);
  });

  it("lists accounts including off-boarded ones, never a password hash", async () => {
    const h = await studioHarness();
    await h.addUser({ username: "ayse.kaya", roles: ["tech-lead"], groups: ["tech-leads"] });
    // Deactivate one so the audit view proves inactive rows are not hidden.
    await h.users.remove("ayse.kaya");
    const token = await adminToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/users", headers: auth(token) });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: Record<string, unknown>[] };
    const ayse = body.items.find((row) => row["username"] === "ayse.kaya");
    expect(ayse).toMatchObject({ username: "ayse.kaya", active: false });
    for (const row of body.items) expect(Object.keys(row)).not.toContain("passwordHash");
  });
});

describe("POST /studio/users", () => {
  const STRONG = "Yeni.Parola-2026!";

  it("refuses a caller who is not an admin", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "POST",
      url: "/studio/users",
      headers: auth(token),
      payload: { username: "yeni.kisi", displayName: "Yeni Kişi", groups: [], password: STRONG },
    });

    expect(response.statusCode).toBe(403);
  });

  it("creates an account and derives its roles from its groups", async () => {
    const h = await studioHarness();
    const token = await adminToken(h);

    const response = await h.app.inject({
      method: "POST",
      url: "/studio/users",
      headers: auth(token),
      payload: {
        username: "mert.demir",
        displayName: "Mert Demir",
        groups: ["tech-leads"],
        password: STRONG,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as Record<string, unknown>;
    // Roles are the platform's reading of groups, not the caller's assertion.
    expect(body["roles"]).toEqual(expect.arrayContaining(["tech-lead", "viewer"]));
    expect(Object.keys(body)).not.toContain("passwordHash");

    // The new account can actually log in with the password it was given.
    const loginToken = await h.login("mert.demir", STRONG);
    expect(typeof loginToken).toBe("string");
  });

  it("rejects a weak password and names the rules it broke", async () => {
    const h = await studioHarness();
    const token = await adminToken(h);

    const response = await h.app.inject({
      method: "POST",
      url: "/studio/users",
      headers: auth(token),
      payload: { username: "zayif.parola", displayName: "Zayıf", groups: [], password: "short" },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: string; details: { violations: string[] } };
    expect(body.error).toBe("password_policy");
    // The screen renders each failed rule; a bare "invalid" would hide which.
    expect(body.details.violations).toEqual(expect.arrayContaining(["too_short"]));
    // A rejected account was never created.
    expect(await h.users.find("zayif.parola")).toBeNull();
  });

  it("rejects a duplicate username", async () => {
    const h = await studioHarness();
    await h.addUser({ username: "var.olan", groups: [] });
    const token = await adminToken(h);

    const response = await h.app.inject({
      method: "POST",
      url: "/studio/users",
      headers: auth(token),
      payload: { username: "var.olan", displayName: "Var Olan", groups: [], password: STRONG },
    });

    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: string }).error).toBe("user_exists");
  });

  it("rejects a group the platform does not know how to map", async () => {
    const h = await studioHarness();
    const token = await adminToken(h);

    const response = await h.app.inject({
      method: "POST",
      url: "/studio/users",
      headers: auth(token),
      payload: {
        username: "gecersiz.grup",
        displayName: "Geçersiz",
        groups: ["some-random-ad-group"],
        password: STRONG,
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toBe("invalid_user_body");
  });
});

describe("PUT /studio/users/:username", () => {
  it("re-derives roles when the groups change", async () => {
    const h = await studioHarness();
    await h.addUser({ username: "ayse.kaya", roles: ["qa"], groups: ["qa"] });
    const token = await adminToken(h);

    const response = await h.app.inject({
      method: "PUT",
      url: "/studio/users/ayse.kaya",
      headers: auth(token),
      payload: { groups: ["tech-leads"] },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { roles: string[]; groups: string[] };
    expect(body.groups).toEqual(["tech-leads"]);
    expect(body.roles.sort()).toEqual(["tech-lead", "viewer"]);
  });

  it("404s an unknown account rather than creating one", async () => {
    const h = await studioHarness();
    const token = await adminToken(h);

    const response = await h.app.inject({
      method: "PUT",
      url: "/studio/users/kimse.yok",
      headers: auth(token),
      payload: { active: false },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe("DELETE /studio/users/:username", () => {
  it("deactivates rather than deletes, keeping the account resolvable for audit", async () => {
    const h = await studioHarness();
    await h.addUser({ username: "giden.kisi", roles: ["tech-lead"], groups: ["tech-leads"] });
    const token = await adminToken(h);

    const response = await h.app.inject({
      method: "DELETE",
      url: "/studio/users/giden.kisi",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { active: boolean }).active).toBe(false);

    // The row is still there — a closed gate's actor must still resolve (M33).
    const still = await h.users.find("giden.kisi");
    expect(still).not.toBeNull();
    expect(still?.active).toBe(false);
  });

  it("refuses a non-admin", async () => {
    const h = await studioHarness();
    await h.addUser({ username: "giden.kisi", groups: [] });
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "DELETE",
      url: "/studio/users/giden.kisi",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(403);
  });
});
