import { describe, expect, it } from "vitest";
import { LdapInsecureTransportError } from "../src/errors.js";
import { decideTransport } from "../src/transport.js";

describe("decideTransport", () => {
  it("accepts ldaps:// in every environment", () => {
    for (const nodeEnv of ["development", "test", "production"]) {
      const decision = decideTransport("ldaps://ad.bank.local:636", {
        allowInsecure: false,
        nodeEnv,
      });
      expect(decision.secure).toBe(true);
    }
  });

  it("refuses plain ldap:// by default in development", () => {
    expect(() =>
      decideTransport("ldap://ad.bank.local:389", { allowInsecure: false, nodeEnv: "development" }),
    ).toThrow(LdapInsecureTransportError);
  });

  it("refuses plain ldap:// in production even when allowInsecure is set", () => {
    // The whole point: a dev override must not survive a deploy.
    expect(() =>
      decideTransport("ldap://ad.bank.local:389", { allowInsecure: true, nodeEnv: "production" }),
    ).toThrow(/NODE_ENV=production/);
  });

  it("allows plain ldap:// only when explicitly opted in outside production", () => {
    const decision = decideTransport("ldap://localhost:389", {
      allowInsecure: true,
      nodeEnv: "development",
    });
    expect(decision.secure).toBe(false);
  });

  it("refuses schemes that are neither ldap nor ldaps", () => {
    for (const url of ["https://ad.bank.local", "ldap+tls://ad.bank.local", "file:///etc/passwd"]) {
      expect(() => decideTransport(url, { allowInsecure: true, nodeEnv: "development" })).toThrow(
        LdapInsecureTransportError,
      );
    }
  });

  it("refuses a malformed URL rather than guessing", () => {
    expect(() => decideTransport("ad.bank.local:636", { allowInsecure: true, nodeEnv: "development" })).toThrow(
      LdapInsecureTransportError,
    );
  });

  it("never reports an insecure decision as secure", () => {
    const decision = decideTransport("ldap://localhost:389", {
      allowInsecure: true,
      nodeEnv: "test",
    });
    expect(decision.secure).toBe(false);
    expect(decision.scheme).toBe("ldap");
  });
});
