import type { GroupRoleMapping } from "./config.js";

/**
 * Directory groups → Maestro roles, by CONFIGURATION rather than convention.
 *
 * What this replaces: `projectGroupFor()` in `apps/bff/src/routes/access.ts`
 * hardcodes `maestro-<projectkey>`. That is a naming convention invented by
 * this platform and imposed on the bank's Active Directory, which already has
 * its own — and an AD group cannot be renamed to suit an application without a
 * change request that touches every group in the tree. So the convention has to
 * move out of the code and into config, which is what this module is.
 *
 * (`projectGroupFor` is left in place and untouched: it governs PROJECT
 * visibility, a different question from role authority, and it is on the local
 * provider's path too. Replacing it is a separate change with its own tests —
 * see RAPOR.md.)
 */

/**
 * Match a directory group against a configured mapping key.
 *
 * Case-insensitive because Active Directory is. Matching succeeds on either the
 * full DN or the bare name, in both directions, so an operator may write
 * `maestro-admins` and have it match an entry that came back as
 * `CN=maestro-admins,OU=Groups,DC=bank,DC=local`. Requiring the operator to
 * predict which form the directory returns is how a mapping silently grants
 * nothing.
 */
function matches(directoryGroup: string, configuredGroup: string): boolean {
  const group = directoryGroup.trim().toLowerCase();
  const configured = configuredGroup.trim().toLowerCase();
  if (group === configured) return true;
  return firstRdnValue(group) === firstRdnValue(configured);
}

/**
 * `CN=maestro-admins,OU=Groups,DC=bank,DC=local` → `maestro-admins`.
 * A value with no `=` is already a bare name and is returned unchanged.
 */
function firstRdnValue(value: string): string {
  const firstRdn = value.split(",")[0] ?? value;
  const equals = firstRdn.indexOf("=");
  return equals === -1 ? firstRdn.trim() : firstRdn.slice(equals + 1).trim();
}

/**
 * Roles for a set of directory groups.
 *
 * The orchestrator's decision, and the contract's note in
 * `packages/contracts/src/identity.ts`, govern what happens to a group this
 * platform has never heard of: it is NOT filtered out of `groups`. The caller
 * receives the directory's names verbatim, because dropping one makes the
 * person look less privileged than the directory made them and leaves no record
 * that anything was discarded — unexplainable at an audit.
 *
 * What an unmapped group grants is nothing at all, which needs no filtering to
 * achieve: `Role` is a closed union and a name outside it never matches a gate.
 * Carried for description, powerless for decision.
 *
 * Roles are deduplicated and returned in a stable order so an audit row for the
 * same person reads identically twice — a set whose order wobbles turns into
 * spurious "permissions changed" diffs.
 */
export function mapGroupsToRoles(
  groups: readonly string[],
  mappings: readonly GroupRoleMapping[],
  defaultRoles: readonly string[],
): readonly string[] {
  const roles = new Set<string>(defaultRoles);
  for (const mapping of mappings) {
    if (groups.some((group) => matches(group, mapping.group))) {
      for (const role of mapping.roles) roles.add(role);
    }
  }
  return [...roles].sort();
}
