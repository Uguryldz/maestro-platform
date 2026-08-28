import { describe, expect, it } from "vitest";
import { Locale, STEP_IDS } from "@maestro/contracts";
import { catalogKeys, DEFAULT_LOCALE, loadEnv, MissingMessageError, t } from "../src/index.js";

describe("loadEnv (M6 fail-closed)", () => {
  it("provides dev defaults", () => {
    const env = loadEnv({});
    expect(env.NODE_ENV).toBe("development");
  });
  it("rejects malformed urls", () => {
    expect(() => loadEnv({ JIRA_BASE_URL: "not-a-url" })).toThrow(/JIRA_BASE_URL/);
  });
  it("refuses to start production with missing connections", () => {
    expect(() => loadEnv({ NODE_ENV: "production" })).toThrow(/required in production/);
  });
  it("accepts a fully configured production env", () => {
    const env = loadEnv({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://maestro:x@db:5432/maestro",
      TEMPORAL_ADDRESS: "temporal:7233",
      JIRA_BASE_URL: "https://jira.corp.local",
      ADO_BASE_URL: "https://tfs.corp.local/Collection",
      VAULT_ADDR: "https://vault.corp.local",
      STORAGE_ENDPOINT: "https://s3.corp.local",
      REDIS_URL: "redis://redis:6379/0",
    });
    expect(env.NODE_ENV).toBe("production");
  });

  /**
   * Redis is required in production for a reason worth stating in a test.
   *
   * Without it every replica falls back to a process-local token bucket, so N
   * replicas grant N times the configured LLM rate and N times the sandbox
   * capacity. Nothing errors — the limits simply stop being limits, which is a
   * bill and an outage rather than a degradation, and it is invisible until it
   * happens.
   */
  it("refuses production without Redis, naming it", () => {
    const withoutRedis = {
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://maestro:x@db:5432/maestro",
      TEMPORAL_ADDRESS: "temporal:7233",
      JIRA_BASE_URL: "https://jira.corp.local",
      ADO_BASE_URL: "https://tfs.corp.local/Collection",
      VAULT_ADDR: "https://vault.corp.local",
      STORAGE_ENDPOINT: "https://s3.corp.local",
    };
    expect(() => loadEnv(withoutRedis)).toThrow(/REDIS_URL/);
    // Development still runs without it: the in-process bucket is correct for
    // one process, and demanding Redis on a laptop would buy nothing.
    expect(() => loadEnv({ ...withoutRedis, NODE_ENV: "development" })).not.toThrow();
  });

  /**
   * Docker Compose has no way to say "unset". `ADO_BASE_URL: ${ADO_BASE_URL:-}`
   * reaches the process as the empty string, so every optional endpoint the bank
   * compose forwards arrives as `""` on a deployment that does not use it.
   *
   * A plain `.optional()` accepts `undefined` and rejects `""` — the one value
   * Compose can actually produce — and the bank bundle therefore refused to boot
   * with four lines of `Invalid URL` naming variables the operator had never set.
   * `OptionalText` already solved this for the LDAP fields; this is the same rule
   * for the endpoints.
   */
  it("treats a blank endpoint as unset, the way Compose delivers one", () => {
    const env = loadEnv({
      JIRA_CLOUD_BASE_URL: "",
      ADO_BASE_URL: "",
      VAULT_ADDR: "",
      STORAGE_ENDPOINT: "",
      EGRESS_PROXY_URL: "",
      DATABASE_URL: "  ",
    });
    expect(env.ADO_BASE_URL).toBeUndefined();
    expect(env.VAULT_ADDR).toBeUndefined();
    expect(env.STORAGE_ENDPOINT).toBeUndefined();
    expect(env.JIRA_CLOUD_BASE_URL).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it("still rejects a non-empty endpoint that is not a URL", () => {
    // Blank means unset; it does not mean "stop checking". A typo must still fail.
    expect(() => loadEnv({ VAULT_ADDR: "vault.corp.local" })).toThrow(/VAULT_ADDR/);
  });

  /**
   * Blank must keep failing in PRODUCTION — it just has to fail legibly. Before
   * this, an empty VAULT_ADDR died in the schema with "Invalid URL", which
   * describes the empty string Compose synthesised and points the operator at
   * nothing. It now reaches the fail-closed check as absent, which names the
   * variable and says what fills it.
   */
  it("fails production on a blank requirement, naming it and what it is for", () => {
    const blanked = {
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://maestro:x@db:5432/maestro",
      TEMPORAL_ADDRESS: "temporal:7233",
      JIRA_BASE_URL: "https://jira.corp.local",
      REDIS_URL: "redis://redis:6379/0",
      ADO_BASE_URL: "",
      VAULT_ADDR: "",
      STORAGE_ENDPOINT: "",
    };
    expect(() => loadEnv(blanked)).toThrow(/VAULT_ADDR: required in production/);
    expect(() => loadEnv(blanked)).toThrow(/secret reference/);
    expect(() => loadEnv(blanked)).not.toThrow(/Invalid URL/);
  });
});

describe("LDAPS identity configuration (M8)", () => {
  const PROD = {
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://maestro:x@db:5432/maestro",
    TEMPORAL_ADDRESS: "temporal:7233",
    JIRA_BASE_URL: "https://jira.corp.local",
    ADO_BASE_URL: "https://tfs.corp.local/Collection",
    VAULT_ADDR: "https://vault.corp.local",
    STORAGE_ENDPOINT: "https://s3.corp.local",
    REDIS_URL: "redis://redis:6379/0",
  };
  const LDAP = {
    IDENTITY_DRIVER: "ldaps-bind",
    LDAP_URL: "ldaps://ad.bank.local:636",
    LDAP_USER_BASE_DN: "OU=Users,DC=bank,DC=local",
    LDAP_BIND_DN: "CN=svc-maestro,OU=Service,DC=bank,DC=local",
  };

  it("defaults to the local driver so existing deployments are unaffected", () => {
    expect(loadEnv({}).IDENTITY_DRIVER).toBe("local");
  });

  it("does not require LDAP settings while the local driver is selected", () => {
    expect(() => loadEnv({ IDENTITY_DRIVER: "local" })).not.toThrow();
  });

  it("requires the directory coordinates as soon as the LDAPS driver is selected", () => {
    // Checked outside production too: a half-configured directory should fail
    // at boot, not at the first login attempt.
    expect(() => loadEnv({ IDENTITY_DRIVER: "ldaps-bind" })).toThrow(/LDAP_URL/);
    expect(() => loadEnv({ IDENTITY_DRIVER: "ldaps-bind" })).toThrow(/LDAP_USER_BASE_DN/);
    expect(() => loadEnv({ IDENTITY_DRIVER: "ldaps-bind" })).toThrow(/LDAP_BIND_DN/);
  });

  it("accepts a fully configured LDAPS deployment", () => {
    const env = loadEnv({ ...PROD, ...LDAP });
    expect(env.IDENTITY_DRIVER).toBe("ldaps-bind");
  });

  it("does not own the service-account reference — that belongs to DeployEnvSchema", () => {
    // The `*_REF` pointers live in apps/deploy, where secret-names.test.ts can
    // derive the MAESTRO_SECRET_* names from them. Declaring one here too would
    // give the same variable two schemas that could disagree.
    expect(loadEnv({ ...PROD, ...LDAP })).not.toHaveProperty("LDAP_BIND_PASSWORD_REF");
  });

  it("refuses plain ldap:// in production", () => {
    expect(() => loadEnv({ ...PROD, ...LDAP, LDAP_URL: "ldap://ad.bank.local:389" })).toThrow(
      /must be ldaps:\/\//,
    );
  });

  it("refuses LDAP_ALLOW_INSECURE in production", () => {
    expect(() => loadEnv({ ...PROD, ...LDAP, LDAP_ALLOW_INSECURE: "true" })).toThrow(
      /LDAP_ALLOW_INSECURE/,
    );
  });

  it("defaults LDAP_ALLOW_INSECURE to false", () => {
    expect(loadEnv({ ...PROD, ...LDAP }).LDAP_ALLOW_INSECURE).toBe(false);
  });

  it("carries a secret REFERENCE, never a password field", () => {
    const env = loadEnv({ ...PROD, ...LDAP });
    // There is deliberately no LDAP_BIND_PASSWORD in the schema.
    expect(env).not.toHaveProperty("LDAP_BIND_PASSWORD");
  });
});

describe("message catalog (M104)", () => {
  it("all locales share the exact same key set", () => {
    const keySets = Locale.options.map((l) => catalogKeys(l));
    for (const keys of keySets.slice(1)) expect(keys).toEqual(keySets[0]);
  });
  it("no catalog entry is empty", () => {
    for (const locale of Locale.options) {
      for (const key of catalogKeys(locale)) {
        expect(t(locale, key).trim().length, `${locale}:${key}`).toBeGreaterThan(0);
      }
    }
  });
  it("every workflow step has a title in every locale", () => {
    for (const locale of Locale.options) {
      for (const step of STEP_IDS) expect(() => t(locale, `steps.${step}`)).not.toThrow();
    }
  });
  it("interpolates params and keeps unknown placeholders visible", () => {
    const msg = t("tr", "notify.gate_open", { ticket: "UGURPAY-501", gate: "PR onayı", owner: "Ayşe" });
    expect(msg).toContain("UGURPAY-501");
    expect(msg).toContain("PR onayı");
    const partial = t("en", "notify.gate_open", { ticket: "UGURPAY-501" });
    expect(partial).toContain("{gate}");
  });
  it("missing keys fail loudly, no silent fallback", () => {
    expect(() => t(DEFAULT_LOCALE, "no.such.key")).toThrow(MissingMessageError);
  });
});
