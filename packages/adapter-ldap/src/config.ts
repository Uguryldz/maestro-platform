import { z } from "zod";
import { LdapConfigError } from "./errors.js";
import { USERNAME_PLACEHOLDER } from "./filter.js";

/**
 * The LDAPS driver's declarative configuration (M8, M44).
 *
 * Everything a bank's directory schema can differ on is a PARAMETER here. The
 * MVP had `maestro-<projectkey>` compiled into `routes/access.ts`, which is
 * fine for a demo and is an audit finding for a deployment: a bank whose AD
 * names groups `CN=APP-MAESTRO-PAYMENTS-RW` cannot express that in code it does
 * not build, so the platform would have had to be forked to be installed.
 */

export const LDAP_IDENTITY_DRIVER = "ldaps-bind";

/** A Vault-style secret reference (`mount/path#field`) — never a secret value. */
const SecretRef = z
  .string()
  .min(1)
  .refine((v) => !v.includes("\n"), "a secret reference is a single line")
  .refine(
    (v) => v.includes("/"),
    "expected a secret REFERENCE like `kv/ldap#service-password`, not a literal password",
  );

/**
 * Group → role mapping, the configurable replacement for the hardcoded rule.
 *
 * `group` is matched against the directory's group names AND their DNs, so an
 * operator may write either `maestro-admins` or the full
 * `CN=maestro-admins,OU=Groups,DC=bank,DC=local` — whichever their AD export
 * gives them. Matching is case-insensitive because AD is.
 *
 * `roles` is the Maestro side and IS validated against the closed union: a typo
 * like `tech-leads` in a config file would otherwise silently grant nothing,
 * and "the mapping is there but the person has no authority" is precisely the
 * bug that takes a day to find. Failing at boot is cheaper.
 */
export const GroupRoleMapping = z.object({
  group: z.string().min(1),
  roles: z
    .array(z.enum(["admin", "tech-lead", "product-owner", "qa", "developer", "viewer"]))
    .min(1, "a mapping with no roles grants nothing — remove it instead of leaving it empty"),
});
export type GroupRoleMapping = z.infer<typeof GroupRoleMapping>;

/**
 * Parse the `LDAP_ROLE_MAPPINGS` environment form into mappings.
 *
 *     "maestro-admins:admin,maestro-leads:tech-lead|developer"
 *
 * A group DN contains commas (`CN=x,OU=Groups,DC=bank,DC=local`), which would
 * collide with the entry separator — so a DN must be written in the JSON array
 * form instead (see `.env.example`). This function REFUSES a value that looks
 * like a bare DN rather than silently splitting it into nonsense keys that
 * would match nothing and grant nothing.
 */
export function parseRoleMappings(raw: string | undefined): GroupRoleMapping[] {
  if (raw === undefined || raw.trim().length === 0) return [];

  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    return z.array(GroupRoleMapping).parse(JSON.parse(trimmed));
  }

  const mappings: GroupRoleMapping[] = [];
  for (const entry of trimmed.split(",")) {
    const item = entry.trim();
    if (item.length === 0) continue;
    const colon = item.indexOf(":");
    if (colon === -1) {
      throw new LdapConfigError(`role mapping "${item}" is not in group:role form`);
    }
    const group = item.slice(0, colon).trim();
    if (/^(cn|ou|dc)=/i.test(group)) {
      throw new LdapConfigError(
        `role mapping group "${group}" looks like a DN, whose commas collide with the entry ` +
          `separator — use the JSON array form for DNs`,
      );
    }
    const roles = item
      .slice(colon + 1)
      .split("|")
      .map((role) => role.trim())
      .filter((role) => role.length > 0);
    mappings.push(GroupRoleMapping.parse({ group, roles }));
  }
  return mappings;
}

export const LdapIdentityConfig = z.object({
  /**
   * `ldaps://host:636`. Plain `ldap://` is refused unless `allowInsecure` is
   * explicitly set AND the process is not in production — see `transport.ts`,
   * which is where that rule is actually enforced.
   */
  url: z.string().min(1),

  /**
   * Escape hatch for a developer running a local test directory with no TLS.
   * Defaults to false, is refused outright under `NODE_ENV=production`, and is
   * named for what it does rather than something soothing like `devMode`: the
   * variable an operator would have to set to break this should read badly in
   * a config review.
   */
  allowInsecure: z.boolean().default(false),

  /**
   * PEM path(s) for the bank's own CA. Corporate directories are almost never
   * signed by a public root, so without this the driver either fails to verify
   * (correct, and useless) or someone turns verification off (catastrophic,
   * and easy). Offering the CA is what makes "never disable verification" a
   * reasonable rule to hold.
   *
   * There is deliberately NO `rejectUnauthorized: false` equivalent in this
   * schema. It is not an oversight — a flag that disables certificate checking
   * is a flag that WILL be set in production by someone under deadline, and it
   * silently converts LDAPS into an interceptable channel.
   */
  caCertPath: z.string().min(1).optional(),

  /** Where user search starts, e.g. `OU=Users,DC=bank,DC=local`. */
  userBaseDn: z.string().min(1),

  /**
   * The user search filter, carrying `{{username}}`. The username is escaped
   * before substitution (RFC 4515) — see `filter.ts`.
   *
   * The default targets Active Directory and excludes disabled accounts at the
   * DIRECTORY, via the `userAccountControl` bit-AND rule (LDAP_MATCHING_RULE_
   * BIT_AND, OID 1.2.840.113556.1.4.803, bit 2 = ACCOUNTDISABLE). The driver
   * ALSO checks the attribute itself after the search: two independent checks,
   * because the audit finding was a cancelled account that stayed admin for
   * eight hours, and a filter is easy to override in config.
   */
  userFilter: z
    .string()
    .min(1)
    .default(`(&(objectClass=user)(sAMAccountName=${USERNAME_PLACEHOLDER})(!(userAccountControl:1.2.840.113556.1.4.803:=2)))`)
    .refine(
      (v) => v.includes(USERNAME_PLACEHOLDER),
      `filter must contain ${USERNAME_PLACEHOLDER}`,
    ),

  /** Where group search starts. Defaults to the user base when unset. */
  groupBaseDn: z.string().min(1).optional(),

  /**
   * Group membership filter, carrying `{{dn}}` (the authenticated user's DN).
   * The AD default follows nested groups via the chain-matching rule
   * (1.2.840.113556.1.4.1941): a person in `payments-devs` which is itself in
   * `maestro-developers` holds the second group in practice, and a mapping that
   * missed it would under-grant in a way nobody reports as a bug — they just
   * quietly cannot do their job.
   */
  groupFilter: z
    .string()
    .min(1)
    .default("(&(objectClass=group)(member:1.2.840.113556.1.4.1941:={{dn}}))"),

  /** Attribute carrying the group's human name. */
  groupNameAttribute: z.string().min(1).default("cn"),

  /** Attribute carrying the login name, echoed back as `username`. */
  usernameAttribute: z.string().min(1).default("sAMAccountName"),

  /**
   * Attribute used to build the audit actor (`user@corp`, M33). AD publishes
   * `userPrincipalName`; the driver falls back to `mail`, then to
   * `<username>@<realm>` so the actor is never empty — an audit row with no
   * actor is an audit row that proves nothing.
   */
  userIdAttribute: z.string().min(1).default("userPrincipalName"),

  /** Suffix for the `userId` fallback when the directory publishes neither UPN nor mail. */
  userIdFallbackDomain: z.string().min(1).optional(),

  /** Service account DN used for the SEARCH bind (never for the user's bind). */
  bindDn: z.string().min(1),

  /** Secret REFERENCE for the service-account password. Resolved via SecretPort. */
  bindPasswordRef: SecretRef,

  /** Group → role mapping. Empty is legal and means "everyone gets the floor role". */
  roleMappings: z.array(GroupRoleMapping).default([]),

  /**
   * The role every authenticated person holds regardless of group membership.
   *
   * `viewer` per the contract's note: an account whose mapping fails should see
   * a read-only platform, not an unbounded one and not a broken one. Set to an
   * empty array only if the bank genuinely wants unmapped staff to see nothing.
   */
  defaultRoles: z
    .array(z.enum(["admin", "tech-lead", "product-owner", "qa", "developer", "viewer"]))
    .default(["viewer"]),

  /** Per-operation timeout. A hung bind must not hold a login request open forever. */
  timeoutMs: z.coerce.number().int().min(1000).max(60_000).default(5_000),
});
export type LdapIdentityConfig = z.infer<typeof LdapIdentityConfig>;
