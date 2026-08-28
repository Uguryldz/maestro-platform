import { ROLES } from "@maestro/contracts";

/**
 * Directory groups → platform roles, as the BFF reads them when an admin
 * creates or edits an account from Studio (M8/M86).
 *
 * The bank's directory owns GROUPS; a role is this platform's reading of group
 * membership, and that reading happens in exactly one place so `admin`,
 * `admins` and `maestro-admins` cannot each become a different answer to "may
 * this person approve". The production `PrismaUserDirectory` re-derives roles
 * from groups on every READ (`rolesOf` in apps/deploy) — this is the same fact
 * on the WRITE path, so a created account holds the roles its groups grant no
 * matter which directory implementation is wired.
 *
 * Kept in step with `ROLE_BY_GROUP` in apps/deploy/src/stores/users.ts. It is
 * duplicated rather than imported because the BFF must not depend on the deploy
 * package (which imports Prisma); `groups.test.ts` pins every value against the
 * frozen `Role` union, so a mapping that drifts to a non-role fails the suite.
 */
export const ROLE_BY_GROUP: Readonly<Record<string, string>> = {
  "maestro-admins": "admin",
  operators: "tech-lead",
  "tech-leads": "tech-lead",
  analysts: "product-owner",
  "product-owners": "product-owner",
  qa: "qa",
  developers: "developer",
  "internal-audit": "viewer",
};

/** The groups an admin may pick from in the Studio "add user" form. */
export const ASSIGNABLE_GROUPS: readonly string[] = Object.keys(ROLE_BY_GROUP);

/**
 * A user's roles, from their groups.
 *
 * `viewer` is the FLOOR, never absent: everyone who can log in can read, and an
 * account whose group mapping grants nothing else is still a viewer rather than
 * an account with no authority at all. An unrecognised group contributes
 * nothing — it does not become a role of its own name, which is what keeps the
 * role set closed (a group added next quarter cannot silently mint authority).
 */
export function rolesOf(groups: readonly string[]): string[] {
  const roles = new Set<string>(["viewer"]);
  for (const group of groups) {
    const role = ROLE_BY_GROUP[group];
    if (role !== undefined) roles.add(role);
  }
  return [...roles];
}

/** The set of role names the contract recognises, for guards and tests. */
export const KNOWN_ROLES: ReadonlySet<string> = new Set(ROLES);
