import { LdapIdentityConfig } from "../src/config.js";
import type { FakeDirectoryOptions } from "./fake-directory.js";

/** A small bank-shaped directory, reused across the suites. */

export const BASE_DN = "OU=Users,DC=bank,DC=local";
export const GROUP_BASE_DN = "OU=Groups,DC=bank,DC=local";
export const SERVICE_DN = "CN=svc-maestro,OU=Service,DC=bank,DC=local";
export const SERVICE_PASSWORD = "svc-correct-horse-battery";

export const ADMINS_DN = `CN=maestro-admins,${GROUP_BASE_DN}`;
export const DEVS_DN = `CN=maestro-developers,${GROUP_BASE_DN}`;
export const PAYMENTS_DN = `CN=payments-squad,${GROUP_BASE_DN}`;
/** A group Maestro has never heard of — carried verbatim, grants nothing. */
export const AUDIT_DN = `CN=internal-audit,${GROUP_BASE_DN}`;

export const ALICE_DN = `CN=alice,${BASE_DN}`;
export const BOB_DN = `CN=bob,${BASE_DN}`;
export const CAROL_DN = `CN=carol,${BASE_DN}`;
/** Deactivated in AD: userAccountControl 512|2 = 514. */
export const DAN_DN = `CN=dan,${BASE_DN}`;

export function directoryOptions(overrides: Partial<FakeDirectoryOptions> = {}): FakeDirectoryOptions {
  return {
    serviceAccounts: { [SERVICE_DN]: SERVICE_PASSWORD },
    accounts: [
      {
        dn: ALICE_DN,
        password: "alice-Password!1",
        attributes: {
          objectClass: ["user"],
          sAMAccountName: ["alice"],
          userPrincipalName: ["alice@bank.local"],
          mail: ["alice@bank.local"],
          userAccountControl: ["512"],
        },
      },
      {
        dn: BOB_DN,
        password: "bob-Password!1",
        attributes: {
          objectClass: ["user"],
          sAMAccountName: ["bob"],
          userPrincipalName: ["bob@bank.local"],
          mail: ["bob@bank.local"],
          userAccountControl: ["512"],
        },
      },
      {
        dn: CAROL_DN,
        password: "carol-Password!1",
        attributes: {
          objectClass: ["user"],
          sAMAccountName: ["carol"],
          // No UPN and no mail: exercises the userId fallback.
          userAccountControl: ["512"],
        },
      },
      {
        dn: DAN_DN,
        password: "dan-Password!1",
        attributes: {
          objectClass: ["user"],
          sAMAccountName: ["dan"],
          userPrincipalName: ["dan@bank.local"],
          mail: ["dan@bank.local"],
          // 514 = NORMAL_ACCOUNT (512) | ACCOUNTDISABLE (2)
          userAccountControl: ["514"],
        },
      },
    ],
    groups: [
      { dn: ADMINS_DN, attributes: { objectClass: ["group"], cn: ["maestro-admins"] }, members: [ALICE_DN] },
      {
        dn: DEVS_DN,
        attributes: { objectClass: ["group"], cn: ["maestro-developers"] },
        // `payments-squad` is nested inside developers: bob is a transitive member.
        members: [CAROL_DN, PAYMENTS_DN],
      },
      { dn: PAYMENTS_DN, attributes: { objectClass: ["group"], cn: ["payments-squad"] }, members: [BOB_DN] },
      { dn: AUDIT_DN, attributes: { objectClass: ["group"], cn: ["internal-audit"] }, members: [ALICE_DN] },
    ],
    ...overrides,
  };
}

export function config(overrides: Record<string, unknown> = {}): LdapIdentityConfig {
  return LdapIdentityConfig.parse({
    url: "ldaps://ad.bank.local:636",
    userBaseDn: BASE_DN,
    groupBaseDn: GROUP_BASE_DN,
    bindDn: SERVICE_DN,
    bindPasswordRef: "kv/ldap#service-password",
    roleMappings: [
      { group: "maestro-admins", roles: ["admin"] },
      { group: "maestro-developers", roles: ["developer"] },
      // Mapped by full DN rather than name, to prove both forms work.
      { group: PAYMENTS_DN, roles: ["qa"] },
    ],
    ...overrides,
  });
}
