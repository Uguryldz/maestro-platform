import { ROLES } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import { ASSIGNABLE_GROUPS, ROLE_BY_GROUP, rolesOf } from "../src/auth/groups.js";

/**
 * The BFF's group→role reading (M8/M86). It mirrors `ROLE_BY_GROUP` in
 * apps/deploy; this suite pins every value against the frozen `Role` union, so
 * a mapping that drifts to a name the contract does not define fails here rather
 * than producing a guard that can never pass.
 */
describe("ROLE_BY_GROUP", () => {
  it("maps every group to a role the contract actually defines", () => {
    for (const role of Object.values(ROLE_BY_GROUP)) {
      expect(ROLES, `"${role}" is not in the Role union`).toContain(role);
    }
  });

  it("offers exactly the mapped groups as assignable", () => {
    expect([...ASSIGNABLE_GROUPS].sort()).toEqual(Object.keys(ROLE_BY_GROUP).sort());
  });
});

describe("rolesOf", () => {
  it("gives everyone at least viewer", () => {
    expect(rolesOf([])).toEqual(["viewer"]);
  });

  it("grants the roles behind a user's groups", () => {
    expect(rolesOf(["tech-leads"]).sort()).toEqual(["tech-lead", "viewer"]);
    expect(rolesOf(["maestro-admins"]).sort()).toEqual(["admin", "viewer"]);
  });

  it("ignores an unrecognised group instead of inventing a role from its name", () => {
    expect(rolesOf(["some-new-ad-group"])).toEqual(["viewer"]);
  });

  it("does not let a group named after a role grant it by coincidence", () => {
    expect(rolesOf(["admin"])).toEqual(["viewer"]);
  });
});
