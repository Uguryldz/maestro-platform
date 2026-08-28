/**
 * A complete, valid environment for the dev profile.
 *
 * Every test that needs a booting deployment starts from this and deletes or
 * overrides the one variable it is about, so a test named "refuses without
 * ADO_ORG" really is testing that one thing rather than an accidentally empty
 * environment.
 *
 * The values are syntactically real and semantically unreachable: nothing here
 * resolves to a host that exists, which is what keeps the suite offline.
 */
export const DEV_ENV: Readonly<Record<string, string>> = {
  NODE_ENV: "development",
  MAESTRO_PROFILE: "dev",
  DATABASE_URL: "postgresql://maestro:pw@db.invalid:5432/maestro",
  TEMPORAL_ADDRESS: "temporal.invalid:7233",
  JIRA_BASE_URL: "https://jira.invalid",
  ADO_BASE_URL: "https://dev.azure.invalid",
  ADO_ORG: "ugurbank",
  ADO_PROJECT: "Core",
  ADO_PR_VALIDATION_BUILDS: "core-api:42",
  LLM_BASE_URL: "https://llm.invalid/v1",
  STORAGE_ENDPOINT: "https://s3.invalid",
  VAULT_ADDR: "https://vault.invalid",
  // Present even in the dev fixture: several tests flip NODE_ENV to production
  // to assert some OTHER refusal, and a missing REQUIRED_IN_PROD key would
  // shadow it — the test would still go red, for the wrong reason.
  REDIS_URL: "redis://redis.invalid:6379/0",
  // Digest-pinned, as M27 and the driver's schema both demand.
  SCAN_IMAGE_TRIVY:
    "aquasec/trivy@sha256:0000000000000000000000000000000000000000000000000000000000000001",
  SCAN_IMAGE_SEMGREP:
    "semgrep/semgrep@sha256:0000000000000000000000000000000000000000000000000000000000000002",
  SCAN_IMAGE_GITLEAKS:
    "zricethezav/gitleaks@sha256:0000000000000000000000000000000000000000000000000000000000000003",
};

/** The prod profile's extra requirement: the one credential Vault cannot hold. */
export const PROD_ENV: Readonly<Record<string, string>> = {
  ...DEV_ENV,
  MAESTRO_PROFILE: "prod",
  VAULT_ROLE_ID: "role-id-for-tests",
  VAULT_SECRET_ID: "secret-id-for-tests",
};

/** `DEV_ENV` without the named keys — for the fail-closed tests. */
export function envWithout(
  base: Readonly<Record<string, string>>,
  ...keys: string[]
): Record<string, string | undefined> {
  const copy: Record<string, string | undefined> = { ...base };
  for (const key of keys) delete copy[key];
  return copy;
}

/** A `SqlExecutor` the pg-blob driver accepts and that never touches a database. */
export const OFFLINE_SQL = {
  query: (): Promise<never[]> => Promise.resolve([]),
};
