import { describe, expect, it } from "vitest";
import { isDisabledAccount } from "../src/account-state.js";
import type { LdapEntry } from "../src/client.js";

function entry(attributes: Record<string, string[]>): LdapEntry {
  return { dn: "CN=x,OU=Users,DC=bank,DC=local", attributes };
}

/**
 * The audit finding behind this file: a cancelled account kept admin authority
 * for eight hours. Sessions are absolute (M8), so login is the only place this
 * can be caught.
 */
describe("isDisabledAccount", () => {
  it("passes a normal enabled account", () => {
    expect(isDisabledAccount(entry({ useraccountcontrol: ["512"] }))).toBe(false);
  });

  it("catches the ACCOUNTDISABLE bit", () => {
    expect(isDisabledAccount(entry({ useraccountcontrol: ["514"] }))).toBe(true);
  });

  it("catches the disable bit alongside other flags", () => {
    // 66050 = ACCOUNTDISABLE | NORMAL_ACCOUNT | DONT_EXPIRE_PASSWORD
    expect(isDisabledAccount(entry({ useraccountcontrol: ["66050"] }))).toBe(true);
  });

  it("does not confuse other flags for the disable bit", () => {
    // 66048 = NORMAL_ACCOUNT | DONT_EXPIRE_PASSWORD — enabled.
    expect(isDisabledAccount(entry({ useraccountcontrol: ["66048"] }))).toBe(false);
  });

  it("treats an unparseable userAccountControl as disabled (fail-closed)", () => {
    expect(isDisabledAccount(entry({ useraccountcontrol: ["not-a-number"] }))).toBe(true);
  });

  it("treats a missing userAccountControl as not-disabled, leaving other checks to decide", () => {
    // OpenLDAP has no such attribute; absence must not lock out an entire directory.
    expect(isDisabledAccount(entry({}))).toBe(false);
  });

  describe("accountExpires (Windows FILETIME)", () => {
    it("treats 0 as never expires", () => {
      expect(isDisabledAccount(entry({ accountexpires: ["0"] }))).toBe(false);
    });

    it("treats the max FILETIME as never expires", () => {
      expect(isDisabledAccount(entry({ accountexpires: ["9223372036854775807"] }))).toBe(false);
    });

    it("catches an account whose expiry has passed", () => {
      // 2020-01-01T00:00:00Z in FILETIME ticks.
      const ticks = (BigInt(Date.UTC(2020, 0, 1)) + 11_644_473_600_000n) * 10_000n;
      const now = new Date("2026-08-09T00:00:00Z");
      expect(isDisabledAccount(entry({ accountexpires: [ticks.toString()] }), now)).toBe(true);
    });

    it("passes an account whose expiry is still in the future", () => {
      const ticks = (BigInt(Date.UTC(2030, 0, 1)) + 11_644_473_600_000n) * 10_000n;
      const now = new Date("2026-08-09T00:00:00Z");
      expect(isDisabledAccount(entry({ accountexpires: [ticks.toString()] }), now)).toBe(false);
    });

    it("treats an unparseable expiry as disabled (fail-closed)", () => {
      expect(isDisabledAccount(entry({ accountexpires: ["soon"] }))).toBe(true);
    });
  });

  it("catches nsAccountLock, for 389-DS and OpenLDAP directories", () => {
    expect(isDisabledAccount(entry({ nsaccountlock: ["TRUE"] }))).toBe(true);
    expect(isDisabledAccount(entry({ nsaccountlock: ["true"] }))).toBe(true);
    expect(isDisabledAccount(entry({ nsaccountlock: ["false"] }))).toBe(false);
  });
});
