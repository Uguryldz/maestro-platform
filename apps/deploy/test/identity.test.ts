import { describe, expect, it } from "vitest";
import type { SecretPort } from "@maestro/ports";
import type { UserDirectory, UserRecord } from "@maestro/bff";
import { loadDeployEnv } from "../src/env.js";
import { ldapConfigFrom, selectIdentityProvider } from "../src/identity.js";
import { DEV_ENV } from "./fixtures.js";

/**
 * The identity-driver switch, offline.
 *
 * No real LDAP server and no real secret store are touched: the LDAP provider
 * is CONSTRUCTED and its declared `driver` inspected, and `ldapConfigFrom` is
 * asserted on directly. The adapter's own suite proves the bind behaviour; this
 * proves the composition — which driver the config selects, and that the map
 * from the environment onto the adapter's config is right.
 */

const fakeSecrets: SecretPort = {
  get: () => Promise.resolve("service-pw"),
  issueShortLived: () => Promise.resolve({ secret: "x", expiresAt: "2026-08-10T00:00:00.000Z" }),
  set: () => Promise.reject(new Error("not used")),
};

const emptyUsers: UserDirectory = {
  find: () => Promise.resolve(null),
  list: () => Promise.resolve([] as readonly UserRecord[]),
  upsert: () => Promise.resolve(),
  remove: () => Promise.resolve(),
};

/** `DEV_ENV` plus the LDAP fields, so `IDENTITY_DRIVER=ldaps-bind` validates. */
const LDAP_ENV: Record<string, string> = {
  ...DEV_ENV,
  IDENTITY_DRIVER: "ldaps-bind",
  LDAP_URL: "ldaps://ad.bank.invalid:636",
  LDAP_USER_BASE_DN: "OU=Users,DC=bank,DC=local",
  LDAP_BIND_DN: "CN=svc-maestro,OU=Svc,DC=bank,DC=local",
  LDAP_GROUP_BASE_DN: "OU=Groups,DC=bank,DC=local",
  LDAP_ROLE_MAPPINGS: "maestro-admins:admin,maestro-qa:qa",
};

describe("selectIdentityProvider", () => {
  it("defaults to the local bcrypt provider when IDENTITY_DRIVER is unset", () => {
    const env = loadDeployEnv({ ...DEV_ENV });
    const provider = selectIdentityProvider(env, { secrets: fakeSecrets, users: emptyUsers });
    expect(provider.driver).toBe("local");
  });

  it("uses the local provider when IDENTITY_DRIVER=local", () => {
    const env = loadDeployEnv({ ...DEV_ENV, IDENTITY_DRIVER: "local" });
    const provider = selectIdentityProvider(env, { secrets: fakeSecrets, users: emptyUsers });
    expect(provider.driver).toBe("local");
  });

  it("builds the LDAPS-bind provider when IDENTITY_DRIVER=ldaps-bind", () => {
    const env = loadDeployEnv(LDAP_ENV);
    const provider = selectIdentityProvider(env, { secrets: fakeSecrets, users: emptyUsers });
    // The adapter's `LdapIdentityProvider.driver` is `"ldaps-bind"`.
    expect(provider.driver).toBe("ldaps-bind");
  });
});

describe("ldapConfigFrom", () => {
  it("maps the deployment's LDAP_* vocabulary onto the adapter's config keys", () => {
    const env = loadDeployEnv(LDAP_ENV);
    const config = ldapConfigFrom(env);
    expect(config["url"]).toBe("ldaps://ad.bank.invalid:636");
    expect(config["userBaseDn"]).toBe("OU=Users,DC=bank,DC=local");
    expect(config["bindDn"]).toBe("CN=svc-maestro,OU=Svc,DC=bank,DC=local");
    expect(config["groupBaseDn"]).toBe("OU=Groups,DC=bank,DC=local");
    // The service password is a REFERENCE, never a literal — from DeployEnvSchema.
    expect(config["bindPasswordRef"]).toBe("kv/ldap#service-password");
  });

  it("parses the role-mapping string into the adapter's mapping objects", () => {
    const env = loadDeployEnv(LDAP_ENV);
    const config = ldapConfigFrom(env);
    expect(config["roleMappings"]).toEqual([
      { group: "maestro-admins", roles: ["admin"] },
      { group: "maestro-qa", roles: ["qa"] },
    ]);
  });

  it("omits optional keys that are unset, so the adapter's defaults win", () => {
    // No USER_FILTER / GROUP_FILTER / CA_CERT_PATH set here.
    const env = loadDeployEnv({ ...LDAP_ENV });
    const config = ldapConfigFrom(env);
    expect(config).not.toHaveProperty("userFilter");
    expect(config).not.toHaveProperty("groupFilter");
    expect(config).not.toHaveProperty("caCertPath");
  });

  it("produces a config the adapter accepts (round-trips through the real provider)", () => {
    // `selectIdentityProvider` calls `createLdapIdentityProvider`, which runs
    // the real `LdapIdentityConfig` parse — so a construction that does not
    // throw proves the mapped config is VALID, not merely shaped right.
    const env = loadDeployEnv(LDAP_ENV);
    expect(() =>
      selectIdentityProvider(env, { secrets: fakeSecrets, users: emptyUsers }),
    ).not.toThrow();
  });
});
