import { describe, expect, it } from "vitest";
import {
  AdoConfigError,
  AdoWebhookAuthError,
  assertServiceHookAuth,
  verifyServiceHookAuth,
} from "../src/index.js";

const expected = { username: "maestro-hook", password: "s3cr3t-shared-value" };

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

describe("Service Hook shared-secret check (fail-closed)", () => {
  it("accepts the configured credential", () => {
    expect(verifyServiceHookAuth(basic(expected.username, expected.password), expected)).toEqual({
      ok: true,
    });
  });

  it("accepts a lowercase scheme and surrounding whitespace", () => {
    const header = ` basic ${Buffer.from(`${expected.username}:${expected.password}`).toString("base64")} `;
    expect(verifyServiceHookAuth(header, expected).ok).toBe(true);
  });

  it("rejects a missing header", () => {
    expect(verifyServiceHookAuth(undefined, expected)).toEqual({ ok: false, reason: "missing" });
    expect(verifyServiceHookAuth(null, expected)).toEqual({ ok: false, reason: "missing" });
    expect(verifyServiceHookAuth("   ", expected)).toEqual({ ok: false, reason: "missing" });
  });

  it("rejects a non-basic or undecodable header", () => {
    expect(verifyServiceHookAuth("Bearer token", expected)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(verifyServiceHookAuth("Basic ****", expected)).toEqual({
      ok: false,
      reason: "malformed",
    });
    const noColon = `Basic ${Buffer.from("nocolonhere", "utf8").toString("base64")}`;
    expect(verifyServiceHookAuth(noColon, expected)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a wrong password, a wrong username and an empty credential", () => {
    expect(verifyServiceHookAuth(basic(expected.username, "wrong"), expected).ok).toBe(false);
    expect(verifyServiceHookAuth(basic("someone-else", expected.password), expected).ok).toBe(false);
    expect(verifyServiceHookAuth(basic("", ""), expected).ok).toBe(false);
  });

  it("supports the empty-username form ADO also allows", () => {
    const credential = { password: "only-the-password" };
    expect(verifyServiceHookAuth(basic("", "only-the-password"), credential).ok).toBe(true);
    expect(verifyServiceHookAuth(basic("x", "only-the-password"), credential).ok).toBe(false);
  });

  it("refuses to run at all when no shared secret is configured", () => {
    expect(() => verifyServiceHookAuth(basic("a", "b"), { password: "" })).toThrow(AdoConfigError);
  });

  it("throws AdoWebhookAuthError from the asserting form", () => {
    expect(() => assertServiceHookAuth(basic(expected.username, expected.password), expected)).not.toThrow();
    try {
      assertServiceHookAuth(undefined, expected);
      expect.unreachable("a missing header must be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(AdoWebhookAuthError);
      expect((error as AdoWebhookAuthError).reason).toBe("missing");
    }
  });

  it("never leaks the expected secret in the error message", () => {
    const error = new AdoWebhookAuthError("mismatch");
    expect(error.message).not.toContain(expected.password);
  });
});
