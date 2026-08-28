import {
  BcryptPasswordHasher,
  LocalIdentityProvider,
  type IdentityProvider,
  type UserDirectory,
} from "@maestro/bff";
import { createLdapIdentityProvider, parseRoleMappings } from "@maestro/adapter-ldap";
import type { SecretPort } from "@maestro/ports";
import type { DeployEnv } from "./env.js";

/**
 * Which identity driver backs logins, selected by config (M8).
 *
 * MVP shipped only the local bcrypt provider. Aşama 2 adds the LDAPS-bind
 * provider, which `@maestro/config`'s `EnvSchema` already knows how to demand
 * (`IDENTITY_DRIVER=ldaps-bind` pulls in the `LDAP_*` requirements) but which
 * nothing had yet CONSTRUCTED. This is the composition seam that does — the one
 * place in the deployment that turns the validated environment into a provider.
 *
 * `@maestro/adapter-ldap` implements the BFF's `IdentityProvider` STRUCTURALLY
 * (M44: a package may not import an app). Its `LdapIdentityProvider.driver` is
 * `"ldaps-bind"` and the local one's is `"local"`, matching the config enum, so
 * the boot banner can name which login path is live.
 */

/** What `selectIdentityProvider` needs beyond the environment. */
export interface IdentityDeps {
  /** Resolves `LDAP_BIND_PASSWORD_REF` at login time — never a literal. */
  readonly secrets: SecretPort;
  /** The local directory, used by the local provider and as the default. */
  readonly users: UserDirectory;
}

/**
 * Build the identity provider the deployment's config asks for.
 *
 * `local` (the default) is the bcrypt provider over the Postgres user
 * directory. `ldaps-bind` is the LDAP provider, built from the validated
 * `LDAP_*` environment and wired to the SecretPort for its service password.
 *
 * There is deliberately NO silent fallback from LDAP to local. The adapter's
 * own `authenticate` fails CLOSED when the directory is unreachable — a login
 * that falls back to a weaker local store on an outage is how an attacker who
 * can drop packets downgrades the bank (see `LdapIdentityProvider`). Selecting
 * `ldaps-bind` therefore means the bank's directory IS the authority, full
 * stop. The local provider stays the DEFAULT (unset/`local` config), not a
 * runtime fallback under it.
 *
 * The switch never touches session or kill-switch durability: those are
 * composed independently in `bff.ts`, so which identity driver is active has no
 * bearing on whether the emergency brake survives a restart.
 */
export function selectIdentityProvider(env: DeployEnv, deps: IdentityDeps): IdentityProvider {
  const driver = env.base.IDENTITY_DRIVER;

  if (driver === "ldaps-bind") {
    return createLdapIdentityProvider(ldapConfigFrom(env), {
      secrets: deps.secrets,
      nodeEnv: env.base.NODE_ENV,
    });
  }

  // `local` (and the default): the bcrypt provider over the Postgres directory.
  // Unchanged and undiminished — the LDAP switch does not weaken this path.
  return new LocalIdentityProvider(deps.users, new BcryptPasswordHasher());
}

/**
 * Map the validated `LDAP_*` environment onto the adapter's config INPUT.
 *
 * The environment is the deployment's vocabulary (`LDAP_USER_BASE_DN`); the
 * adapter's schema is the driver's (`userBaseDn`). This function is the only
 * translation between them, and it stays a plain object handed to
 * `createLdapIdentityProvider` — which runs the real `LdapIdentityConfig`
 * parse, so a bad value fails there with the driver's own message rather than
 * being half-validated here.
 *
 * Only keys with a value are set: the adapter's schema carries defaults for the
 * filters, attributes and timeouts, and passing `undefined` for one would
 * override the default with nothing. `@maestro/config` already guaranteed the
 * three required fields are present when `IDENTITY_DRIVER=ldaps-bind`, so the
 * non-null assertions below cannot fire in a validly-booted process — but they
 * are written as explicit throws rather than `!` so a future config change that
 * dropped a requirement fails loudly here instead of constructing a provider
 * with an empty base DN that silently finds nobody.
 */
export function ldapConfigFrom(env: DeployEnv): Record<string, unknown> {
  const base = env.base;
  const config: Record<string, unknown> = {
    url: required(base.LDAP_URL, "LDAP_URL"),
    userBaseDn: required(base.LDAP_USER_BASE_DN, "LDAP_USER_BASE_DN"),
    bindDn: required(base.LDAP_BIND_DN, "LDAP_BIND_DN"),
    bindPasswordRef: env.LDAP_BIND_PASSWORD_REF,
    allowInsecure: base.LDAP_ALLOW_INSECURE,
    roleMappings: parseRoleMappings(base.LDAP_ROLE_MAPPINGS),
  };

  // Optional passthroughs — set only when present so the adapter's defaults win.
  if (base.LDAP_GROUP_BASE_DN !== undefined) config["groupBaseDn"] = base.LDAP_GROUP_BASE_DN;
  if (base.LDAP_CA_CERT_PATH !== undefined) config["caCertPath"] = base.LDAP_CA_CERT_PATH;
  if (base.LDAP_USER_FILTER !== undefined) config["userFilter"] = base.LDAP_USER_FILTER;
  if (base.LDAP_GROUP_FILTER !== undefined) config["groupFilter"] = base.LDAP_GROUP_FILTER;

  return config;
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      `${name}: required when IDENTITY_DRIVER=ldaps-bind — the login path must not be built ` +
        `with an empty directory setting that silently finds nobody (M8)`,
    );
  }
  return value;
}
