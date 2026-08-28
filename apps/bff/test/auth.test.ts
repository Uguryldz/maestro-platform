import { describe, expect, it } from "vitest";
import { MAX_SESSIONS_PER_USER, SESSION_TTL_MS } from "../src/auth/sessions.js";
import { auth, harness, TEST_PASSWORD } from "./helpers.js";

/** Every REST route, so a new one cannot quietly ship without a guard (M7). */
const GUARDED_ROUTES: ReadonlyArray<{ method: "GET" | "POST" | "PUT"; url: string }> = [
  { method: "GET", url: "/runs" },
  { method: "GET", url: "/runs/UGURPAY-1" },
  { method: "POST", url: "/runs/UGURPAY-1/signals/gateDecision" },
  { method: "GET", url: "/params" },
  { method: "PUT", url: "/params/reminder.channel" },
  { method: "GET", url: "/killswitch" },
  { method: "POST", url: "/killswitch" },
  { method: "POST", url: "/auth/logout" },
  { method: "GET", url: "/auth/session" },
];

describe("identity and sessions (M8)", () => {
  it("issues an eight-hour session for valid credentials", async () => {
    const h = await harness();
    await h.addUser({ username: "ayse.kaya", roles: ["admin"] });

    const response = await h.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "ayse.kaya", password: TEST_PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { token: string; expiresAt: string; user: { userId: string } };
    expect(body.user.userId).toBe("ayse.kaya@ugurbank.local");
    expect(Date.parse(body.expiresAt) - h.clock.now().getTime()).toBe(SESSION_TTL_MS);
  });

  it("rejects a wrong password without saying which half was wrong", async () => {
    const h = await harness();
    await h.addUser({ username: "ayse.kaya" });

    const wrongPassword = await h.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "ayse.kaya", password: "Definitely-Not-It-1!" },
    });
    const unknownUser = await h.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "hayalet", password: TEST_PASSWORD },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownUser.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual(unknownUser.json());
  });

  it("refuses a deactivated account", async () => {
    const h = await harness();
    await h.addUser({ username: "ayrilan.kisi" });
    const record = await h.users.find("ayrilan.kisi");
    await h.users.upsert({ ...record!, active: false });

    const response = await h.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "ayrilan.kisi", password: TEST_PASSWORD },
    });

    expect(response.statusCode).toBe(401);
  });

  it("stops accepting a session once its eight hours are up", async () => {
    const h = await harness();
    await h.addUser({ username: "ayse.kaya" });
    const token = await h.login("ayse.kaya");

    const before = await h.app.inject({ method: "GET", url: "/runs", headers: auth(token) });
    expect(before.statusCode).toBe(200);

    h.clock.advance(SESSION_TTL_MS + 1);

    const after = await h.app.inject({ method: "GET", url: "/runs", headers: auth(token) });
    expect(after.statusCode).toBe(401);
    expect(after.json()).toEqual({ error: "session_expired" });
    // The expired record is dropped, not merely refused.
    expect(await h.sessions.get(token)).toBeNull();
  });

  it("ends the session on logout", async () => {
    const h = await harness();
    await h.addUser({ username: "ayse.kaya" });
    const token = await h.login("ayse.kaya");

    expect((await h.app.inject({ method: "POST", url: "/auth/logout", headers: auth(token) })).statusCode).toBe(204);
    expect((await h.app.inject({ method: "GET", url: "/runs", headers: auth(token) })).statusCode).toBe(401);
  });

  it.each(GUARDED_ROUTES)("refuses $method $url without a token", async (route) => {
    const h = await harness();
    const response = await h.app.inject({ method: route.method, url: route.url, payload: {} });
    expect(response.statusCode).toBe(401);
  });

  it.each(GUARDED_ROUTES)("refuses $method $url with a made-up token", async (route) => {
    const h = await harness();
    const response = await h.app.inject({
      method: route.method,
      url: route.url,
      headers: auth("not-a-real-token"),
      payload: {},
    });
    expect(response.statusCode).toBe(401);
  });

  it("leaves the health probes open", async () => {
    const h = await harness();
    expect((await h.app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect((await h.app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
  });

  it("reports the session behind the token", async () => {
    const h = await harness();
    await h.addUser({ username: "ayse.kaya", roles: ["admin"], groups: ["tech-leads"] });
    const token = await h.login("ayse.kaya");

    const response = await h.app.inject({ method: "GET", url: "/auth/session", headers: auth(token) });

    expect(response.json()).toMatchObject({
      userId: "ayse.kaya@ugurbank.local",
      roles: ["admin"],
      groups: ["tech-leads"],
      delegated: false,
    });
  });
});

/**
 * A session is a cached copy of an account, and the account is the truth. An
 * eight-hour token that outlives the off-boarding it was issued before hands a
 * departed employee up to eight hours of their old authority (M8/M32).
 */
describe("account state is re-read on every request (M8)", () => {
  it("refuses a token whose account was deactivated", async () => {
    const h = await harness();
    await h.addUser({ username: "ayrilan.kisi", roles: ["admin"] });
    const token = await h.login("ayrilan.kisi");
    expect((await h.app.inject({ method: "GET", url: "/runs", headers: auth(token) })).statusCode).toBe(200);

    const record = await h.users.find("ayrilan.kisi");
    await h.users.upsert({ ...record!, active: false });

    const response = await h.app.inject({ method: "GET", url: "/runs", headers: auth(token) });

    expect(response.statusCode).toBe(401);
    // Refused AND forgotten: the record must not linger for the next request.
    expect(await h.sessions.get(token)).toBeNull();
  });

  it("refuses a token whose account was deleted outright", async () => {
    const h = await harness();
    await h.addUser({ username: "ayse.kaya" });
    const token = await h.login("ayse.kaya");

    await h.users.remove("ayse.kaya");

    expect((await h.app.inject({ method: "GET", url: "/runs", headers: auth(token) })).statusCode).toBe(401);
  });

  it("stops honouring a role that was revoked after login", async () => {
    const h = await harness();
    await h.addUser({ username: "eski.admin", roles: ["admin"] });
    const token = await h.login("eski.admin");
    const kill = { level: "all", reason: "test" };
    expect(
      (await h.app.inject({ method: "POST", url: "/killswitch", headers: auth(token), payload: kill }))
        .statusCode,
    ).toBe(200);

    const record = await h.users.find("eski.admin");
    await h.users.upsert({ ...record!, roles: [] });

    const response = await h.app.inject({
      method: "POST",
      url: "/killswitch",
      headers: auth(token),
      payload: kill,
    });

    expect(response.statusCode).toBe(403);
  });

  it("honours a role GRANTED after login without a re-login", async () => {
    const h = await harness();
    await h.addUser({ username: "yeni.admin", roles: [] });
    const token = await h.login("yeni.admin");

    const record = await h.users.find("yeni.admin");
    await h.users.upsert({ ...record!, roles: ["admin"] });

    const response = await h.app.inject({
      method: "POST",
      url: "/killswitch",
      headers: auth(token),
      payload: { level: "intake_only", reason: "test" },
    });

    expect(response.statusCode).toBe(200);
  });

  it("uses the directory's groups, not the ones frozen at login", async () => {
    const h = await harness();
    await h.addUser({ username: "ayse.kaya", groups: ["eski-grup"] });
    const token = await h.login("ayse.kaya");

    const record = await h.users.find("ayse.kaya");
    await h.users.upsert({ ...record!, groups: ["yeni-grup"] });

    const response = await h.app.inject({ method: "GET", url: "/auth/session", headers: auth(token) });

    expect(response.json()).toMatchObject({ groups: ["yeni-grup"] });
  });
});

/**
 * Logging out of one browser must end the account's other sessions too: an
 * attacker who stole a token is not going to press "log out" themselves, and
 * a revoked role means every credential of that person is suspect (M8/M32).
 */
describe("session revocation across an account", () => {
  it("drops every session of the user on logout", async () => {
    const h = await harness();
    await h.addUser({ username: "ayse.kaya" });
    const first = await h.login("ayse.kaya");
    const second = await h.login("ayse.kaya");

    await h.app.inject({ method: "POST", url: "/auth/logout", headers: auth(first) });

    expect((await h.app.inject({ method: "GET", url: "/runs", headers: auth(second) })).statusCode).toBe(401);
  });

  it("leaves OTHER users' sessions alone", async () => {
    const h = await harness();
    await h.addUser({ username: "ayse.kaya" });
    await h.addUser({ username: "mert.demir" });
    const ayse = await h.login("ayse.kaya");
    const mert = await h.login("mert.demir");

    await h.app.inject({ method: "POST", url: "/auth/logout", headers: auth(ayse) });

    expect((await h.app.inject({ method: "GET", url: "/runs", headers: auth(mert) })).statusCode).toBe(200);
  });

  it("caps how many sessions one account can hold at once", async () => {
    const h = await harness();
    await h.addUser({ username: "ayse.kaya" });

    const tokens: string[] = [];
    for (let index = 0; index < MAX_SESSIONS_PER_USER + 2; index += 1) {
      tokens.push(await h.login("ayse.kaya"));
    }

    const live = await Promise.all(
      tokens.map(async (token) =>
        (await h.app.inject({ method: "GET", url: "/runs", headers: auth(token) })).statusCode,
      ),
    );

    expect(live.filter((status) => status === 200)).toHaveLength(MAX_SESSIONS_PER_USER);
    // The OLDEST are the ones evicted; the newest login always works.
    expect(live.at(-1)).toBe(200);
    expect(live[0]).toBe(401);
  });
});
