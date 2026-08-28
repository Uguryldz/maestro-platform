import { describe, expect, it } from "vitest";
import { auth, harness } from "./helpers.js";

/**
 * The first-run bootstrap admin (banking standard, migration 0009).
 *
 * A fresh install ships one `admin`/`admin123` account whose password is
 * policy-EXEMPT — because it MUST be changed immediately. Until it is, the
 * session is RESTRICTED: it may reach change-password, logout and session, and
 * nothing else. The change-password endpoint runs the FULL policy on the new
 * password (so `admin123` cannot be re-set) and kills every session of the
 * account on success.
 */

/** A password that satisfies the M8 policy (min 12, upper/lower/digit/symbol). */
const STRONG = "Maestro!First-2026";

describe("first-run bootstrap admin (M8, migration 0009)", () => {
  it("logs in with admin123 and reports mustChangePassword=true", async () => {
    const h = await harness();
    await h.seedBootstrapAdmin();

    const response = await h.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "admin", password: "admin123" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { token: string; user: { mustChangePassword: boolean } };
    expect(body.user.mustChangePassword).toBe(true);
    expect(body.token).toBeTruthy();
  });

  it("session GET reports the flag so the client can force the change", async () => {
    const h = await harness();
    await h.seedBootstrapAdmin();
    const token = await h.login("admin", "admin123");

    const session = await h.app.inject({ method: "GET", url: "/auth/session", headers: auth(token) });
    expect(session.statusCode).toBe(200);
    expect((session.json() as { mustChangePassword: boolean }).mustChangePassword).toBe(true);
  });

  it("refuses a normal route while restricted (409 password_change_required)", async () => {
    const h = await harness();
    await h.seedBootstrapAdmin();
    const token = await h.login("admin", "admin123");

    // /runs is an ordinary read; /killswitch is an admin write. Both refused.
    const runs = await h.app.inject({ method: "GET", url: "/runs", headers: auth(token) });
    expect(runs.statusCode).toBe(409);
    expect((runs.json() as { error: string }).error).toBe("password_change_required");

    const killswitch = await h.app.inject({
      method: "POST",
      url: "/killswitch",
      headers: auth(token),
      payload: { level: "all", reason: "test" },
    });
    expect(killswitch.statusCode).toBe(409);
    expect((killswitch.json() as { error: string }).error).toBe("password_change_required");
  });

  it("allows change-password, logout and session while restricted", async () => {
    const h = await harness();
    await h.seedBootstrapAdmin();
    const token = await h.login("admin", "admin123");

    // change-password reachable (proven by the rejects/accepts tests below);
    // here we only prove logout and session are not 409'd.
    const session = await h.app.inject({ method: "GET", url: "/auth/session", headers: auth(token) });
    expect(session.statusCode).toBe(200);

    const logout = await h.app.inject({ method: "POST", url: "/auth/logout", headers: auth(token) });
    expect(logout.statusCode).toBe(204);
  });

  it("rejects a weak new password on the policy — cannot change back to admin123", async () => {
    const h = await harness();
    await h.seedBootstrapAdmin();
    const token = await h.login("admin", "admin123");

    const response = await h.app.inject({
      method: "POST",
      url: "/auth/change-password",
      headers: auth(token),
      payload: { currentPassword: "admin123", newPassword: "admin123" },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: string; details: { violations: string[] } };
    expect(body.error).toBe("password_policy");
    // admin123 meets the 8-char minimum but has no symbol/upper — still refused,
    // so the bootstrap password can never be re-set as the new one.
    expect(body.details.violations).toContain("no_symbol");
    expect(body.details.violations).toContain("no_upper");
  });

  it("rejects a wrong current password without changing anything", async () => {
    const h = await harness();
    await h.seedBootstrapAdmin();
    const token = await h.login("admin", "admin123");

    const response = await h.app.inject({
      method: "POST",
      url: "/auth/change-password",
      headers: auth(token),
      payload: { currentPassword: "not-the-password", newPassword: STRONG },
    });

    expect(response.statusCode).toBe(401);
    // The account is untouched: the old password still logs in, still restricted.
    const stillOld = await h.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "admin", password: "admin123" },
    });
    expect(stillOld.statusCode).toBe(200);
    expect((stillOld.json() as { user: { mustChangePassword: boolean } }).user.mustChangePassword).toBe(true);
  });

  it("clears the flag on a successful change and kills every other session", async () => {
    const h = await harness();
    await h.seedBootstrapAdmin();
    const first = await h.login("admin", "admin123");
    const second = await h.login("admin", "admin123"); // a second live token

    const change = await h.app.inject({
      method: "POST",
      url: "/auth/change-password",
      headers: auth(first),
      payload: { currentPassword: "admin123", newPassword: STRONG },
    });
    expect(change.statusCode).toBe(204);

    // Both the calling token AND the other session are dead now.
    const withFirst = await h.app.inject({ method: "GET", url: "/auth/session", headers: auth(first) });
    expect(withFirst.statusCode).toBe(401);
    const withSecond = await h.app.inject({ method: "GET", url: "/auth/session", headers: auth(second) });
    expect(withSecond.statusCode).toBe(401);

    // admin123 no longer works at all.
    const oldPassword = await h.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "admin", password: "admin123" },
    });
    expect(oldPassword.statusCode).toBe(401);
  });

  it("second login with the NEW password is unrestricted", async () => {
    const h = await harness();
    await h.seedBootstrapAdmin();
    const token = await h.login("admin", "admin123");
    await h.app.inject({
      method: "POST",
      url: "/auth/change-password",
      headers: auth(token),
      payload: { currentPassword: "admin123", newPassword: STRONG },
    });

    const login = await h.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "admin", password: STRONG },
    });
    expect(login.statusCode).toBe(200);
    const body = login.json() as { token: string; user: { mustChangePassword: boolean } };
    expect(body.user.mustChangePassword).toBe(false);

    // And a normal route is now reachable — no longer 409'd.
    const runs = await h.app.inject({ method: "GET", url: "/runs", headers: auth(body.token) });
    expect(runs.statusCode).toBe(200);
  });

  it("a normal (provisioned) account is never restricted", async () => {
    const h = await harness();
    await h.addUser({ username: "ayse.kaya", roles: ["admin"] });
    const token = await h.login("ayse.kaya");

    const login = await h.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "ayse.kaya", password: "Maestro!Test-2026" },
    });
    expect((login.json() as { user: { mustChangePassword: boolean } }).user.mustChangePassword).toBe(false);

    const runs = await h.app.inject({ method: "GET", url: "/runs", headers: auth(token) });
    expect(runs.statusCode).toBe(200);
  });
});
