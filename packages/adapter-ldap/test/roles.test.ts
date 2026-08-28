import { describe, expect, it } from "vitest";
import { ROLES } from "@maestro/contracts";
import { GroupRoleMapping, LdapIdentityConfig } from "../src/config.js";
import { mapGroupsToRoles } from "../src/roles.js";

describe("mapGroupsToRoles", () => {
  const mappings: GroupRoleMapping[] = [
    { group: "maestro-admins", roles: ["admin"] },
    { group: "CN=maestro-qa,OU=Groups,DC=bank,DC=local", roles: ["qa"] },
    { group: "maestro-leads", roles: ["tech-lead", "developer"] },
  ];

  it("maps a bare group name", () => {
    expect(mapGroupsToRoles(["maestro-admins"], mappings, ["viewer"])).toEqual(["admin", "viewer"]);
  });

  it("matches a configured bare name against a DN from the directory", () => {
    const roles = mapGroupsToRoles(["CN=maestro-admins,OU=Groups,DC=bank,DC=local"], mappings, []);
    expect(roles).toEqual(["admin"]);
  });

  it("matches a configured DN against a bare name from the directory", () => {
    expect(mapGroupsToRoles(["maestro-qa"], mappings, [])).toEqual(["qa"]);
  });

  it("is case-insensitive, because Active Directory is", () => {
    expect(mapGroupsToRoles(["MAESTRO-ADMINS"], mappings, [])).toEqual(["admin"]);
  });

  it("grants every role of every matching group", () => {
    const roles = mapGroupsToRoles(["maestro-admins", "maestro-leads"], mappings, ["viewer"]);
    expect(roles).toEqual(["admin", "developer", "tech-lead", "viewer"]);
  });

  it("grants nothing for a group Maestro has never heard of", () => {
    expect(mapGroupsToRoles(["internal-audit", "release-managers"], mappings, [])).toEqual([]);
  });

  it("still returns the floor role when nothing matches", () => {
    expect(mapGroupsToRoles(["internal-audit"], mappings, ["viewer"])).toEqual(["viewer"]);
  });

  it("deduplicates and orders stably, so audit rows do not churn", () => {
    const overlapping: GroupRoleMapping[] = [
      { group: "a", roles: ["developer"] },
      { group: "b", roles: ["developer", "qa"] },
    ];
    const first = mapGroupsToRoles(["b", "a"], overlapping, ["viewer"]);
    const second = mapGroupsToRoles(["a", "b"], overlapping, ["viewer"]);

    expect(first).toEqual(["developer", "qa", "viewer"]);
    expect(first).toEqual(second);
  });

  it("only ever emits names from the closed role set", () => {
    const roles = mapGroupsToRoles(["maestro-admins", "maestro-leads"], mappings, ["viewer"]);
    for (const role of roles) expect(ROLES).toContain(role);
  });
});

describe("config validation", () => {
  const base = {
    url: "ldaps://ad.bank.local:636",
    userBaseDn: "OU=Users,DC=bank,DC=local",
    bindDn: "CN=svc,DC=bank,DC=local",
    bindPasswordRef: "kv/ldap#service-password",
  };

  it("rejects a role name outside the closed union at boot", () => {
    // A typo like `tech-leads` would otherwise grant nothing, silently.
    const result = LdapIdentityConfig.safeParse({
      ...base,
      roleMappings: [{ group: "x", roles: ["tech-leads"] }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a mapping with no roles", () => {
    const result = LdapIdentityConfig.safeParse({
      ...base,
      roleMappings: [{ group: "x", roles: [] }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a literal password where a secret reference belongs", () => {
    const result = LdapIdentityConfig.safeParse({ ...base, bindPasswordRef: "hunter2" });
    expect(result.success).toBe(false);
  });

  it("rejects a user filter with no {{username}} placeholder", () => {
    const result = LdapIdentityConfig.safeParse({
      ...base,
      userFilter: "(objectClass=user)",
    });
    expect(result.success).toBe(false);
  });

  it("defaults to viewer as the floor role", () => {
    const parsed = LdapIdentityConfig.parse(base);
    expect(parsed.defaultRoles).toEqual(["viewer"]);
  });

  it("defaults allowInsecure to false", () => {
    expect(LdapIdentityConfig.parse(base).allowInsecure).toBe(false);
  });

  it("has no option to disable certificate verification", () => {
    const parsed = LdapIdentityConfig.parse({ ...base, rejectUnauthorized: false, tlsInsecure: true });
    // Unknown keys are stripped rather than honoured: there is no such switch.
    expect(parsed).not.toHaveProperty("rejectUnauthorized");
    expect(parsed).not.toHaveProperty("tlsInsecure");
  });
});
