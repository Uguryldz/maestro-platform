import { z } from "zod";

/**
 * Process environment schema. Fail-closed (M6): in production every
 * connection value must be present — the process refuses to start rather
 * than run half-configured. Dev gets local defaults.
 */
/**
 * An optional setting that treats "" as absent.
 *
 * Docker Compose interpolates an unset variable to an EMPTY STRING, not to
 * nothing — `LDAP_URL: ${LDAP_URL:-}` reaches the process as `LDAP_URL=""`. A
 * plain `.optional()` accepts `undefined` and rejects `""`, so a deployment
 * that simply does not use LDAP failed to boot with seven "expected string to
 * have >=1 characters" errors. Blank means unset; a value that is present is
 * still held to its minimum.
 */
const OptionalText = z
  .string()
  .transform((value) => (value.trim() === "" ? undefined : value))
  .pipe(z.string().min(1).optional())
  .optional();

/**
 * The same rule for an optional ENDPOINT. Blank means unset; anything present is
 * still held to being a real URL.
 *
 * `OptionalText` fixed the LDAP half of this problem and the URL fields were
 * left on a plain `.optional()`, so the bank bundle refused to boot with four
 * lines of `Invalid URL` for four variables the operator had never set. Compose
 * forwards `ADO_BASE_URL: ${ADO_BASE_URL:-}`, the process receives `""`, and
 * `.optional()` accepts `undefined` while rejecting the empty string — the one
 * value Compose can actually produce for an unset variable.
 *
 * This is deliberately NOT a licence to skip these settings in production: the
 * three that a production deployment cannot work without are listed in
 * `REQUIRED_IN_PROD` below, and blank now reaches that check as absent. The
 * difference is the failure an operator reads. "Invalid URL" describes the empty
 * string Compose synthesised and points at nothing; "VAULT_ADDR: required in
 * production" names the variable the operator has to go and fill in.
 */
const BlankableUrl = z
  .string()
  .transform((value) => (value.trim() === "" ? undefined : value))
  .pipe(z.url().optional())
  .optional();

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /**
   * Where the BFF listens. Studio is served on 7000 and calls 7001 (M7 port
   * map). The default HOST is loopback on purpose: a service that binds
   * 0.0.0.0 because nobody set a variable is exposed by omission, and inside a
   * container the compose file sets this explicitly.
   */
  BFF_PORT: z.coerce.number().int().min(1).max(65535).default(7001),
  BFF_HOST: z.string().min(1).default("127.0.0.1"),
  DATABASE_URL: BlankableUrl,
  TEMPORAL_ADDRESS: z.string().min(1).optional(),
  JIRA_BASE_URL: BlankableUrl,
  /**
   * The Jira CLOUD site, when the deployment talks to Cloud rather than to a
   * Data Center instance. Two variables because they are two DRIVERS with two
   * auth schemes — Cloud authenticates `Basic email:token`, DC sends a
   * `Bearer` PAT — and a deployment picks one. `apps/deploy`'s
   * `jiraCloudConfig` has read this name off the raw environment since the
   * Cloud driver landed; declaring it here is what lets the rest of the
   * platform (the settings screen above all) see the same site the work port
   * is actually pointed at.
   *
   * Deliberately NOT in `REQUIRED_IN_PROD`: `JIRA_BASE_URL` already stands for
   * "a Jira is configured", and demanding both would refuse to boot every
   * Data-Center deployment there is.
   */
  JIRA_CLOUD_BASE_URL: BlankableUrl,
  ADO_BASE_URL: BlankableUrl,
  VAULT_ADDR: BlankableUrl,
  STORAGE_ENDPOINT: BlankableUrl,
  EGRESS_PROXY_URL: BlankableUrl,

  /**
   * The Cloud accountId the ENGINE acts as — the account the pilot's discovery
   * JQL filters on (`assignee = "<id>"`, see `apps/pilot/src/env.ts`).
   *
   * The BFF does not run discovery, so it never USES this to fetch anything.
   * It reads it for one purpose: to notice when the managed Jira connection
   * authenticates as somebody else. A deployment can hold two Jira identities
   * at once — a human's personal token on the connection, the bot's token on
   * the engine — and nothing then contradicts either. The connection faithfully
   * learns its own owner, the wizard pre-fills that id into a listening rule,
   * and the rule is compared against an assignee it can never equal. Every such
   * rule matches nothing, silently, and the run falls back to the deployment
   * default with no error anywhere. The connector test compares the two and
   * WARNS; this is the only channel by which it can know the engine's half.
   *
   * Optional and NOT in `REQUIRED_IN_PROD`: an install that never adopted the
   * assignment-based flow has no such id, and the check simply does not run —
   * absent means "nothing to compare", never "they disagree".
   */
  MAESTRO_BOT_ACCOUNT_ID: OptionalText,

  // ── identity: AD/LDAPS (M8) ─────────────────────────────────────────────
  /**
   * Which identity driver the deployment uses. `local` is the MVP bcrypt
   * store; `ldaps-bind` authenticates against the bank's directory.
   *
   * Defaulting to `local` keeps every existing dev setup and test working
   * unchanged; a bank deployment sets this to `ldaps-bind` and is then held to
   * the LDAP_* requirements below.
   */
  IDENTITY_DRIVER: z.enum(["local", "ldaps-bind"]).default("local"),
  /** `ldaps://ad.bank.local:636`. Plain `ldap://` is refused in production. */
  LDAP_URL: OptionalText,
  /** Where user search starts, e.g. `OU=Users,DC=bank,DC=local`. */
  LDAP_USER_BASE_DN: OptionalText,
  /** Where group search starts. Falls back to the user base when unset. */
  LDAP_GROUP_BASE_DN: OptionalText,
  /** Service account DN used for the SEARCH bind — never for a user's bind. */
  LDAP_BIND_DN: OptionalText,
  /**
   * The service-account password is a secret REFERENCE and lives in
   * `apps/deploy`'s `DeployEnvSchema` with every other `*_REF`, NOT here.
   * That file owns the pointers, and `secret-names.test.ts` derives the
   * `MAESTRO_SECRET_*` variable names from its defaults — a reference declared
   * in this schema would be invisible to that check.
   */
  /** PEM path for the bank's own CA. Corporate roots are not publicly trusted. */
  LDAP_CA_CERT_PATH: OptionalText,
  /** User search filter carrying `{{username}}`; the driver escapes the value. */
  LDAP_USER_FILTER: OptionalText,
  /** Group membership filter carrying `{{dn}}`. */
  LDAP_GROUP_FILTER: OptionalText,
  /**
   * Group → role mapping, as `group:role1|role2` entries separated by commas:
   *
   *     maestro-admins:admin,maestro-qa:qa,maestro-leads:tech-lead|developer
   *
   * The bank's AD naming is a deployment fact, not a platform convention — this
   * is what replaces the hardcoded `maestro-<projectkey>` rule.
   */
  LDAP_ROLE_MAPPINGS: OptionalText,
  /**
   * Escape hatch for a local test directory with no TLS. Refused outright when
   * `NODE_ENV=production`, whatever this says. Named for what it does: the
   * variable someone would set to break this should read badly in review.
   */
  LDAP_ALLOW_INSECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  /**
   * Redis, for cross-process coordination (M4): the atomic token bucket
   * (M19), the capacity semaphore, the distributed lock and the cache layer.
   *
   * `z.string()` rather than `z.url()`, unlike every other endpoint above:
   * Zod's URL check demands a scheme it recognises, and `redis://` /
   * `rediss://` are refused by it. `parseRedisUrl` in `@maestro/cache` does
   * the real validation — scheme, host, database index — and it does it at
   * boot, so a malformed value still fails in front of an operator rather
   * than at the first rate-limit check.
   *
   * Required in production, and the reason is not tidiness: without it every
   * replica runs a process-local token bucket, so N replicas grant N times the
   * configured LLM rate and N times the sandbox capacity. That is a bill and an
   * outage, not a degradation, which is why it sits in REQUIRED_IN_PROD below.
   */
  REDIS_URL: OptionalText,
});
export type Env = z.infer<typeof EnvSchema>;

const REQUIRED_IN_PROD = [
  "DATABASE_URL",
  "TEMPORAL_ADDRESS",
  "JIRA_BASE_URL",
  "ADO_BASE_URL",
  "VAULT_ADDR",
  "STORAGE_ENDPOINT",
  /**
   * Added when `@maestro/cache` landed (orchestrator, 2026-08-09). Its author
   * left it out of this list on purpose — the list is a cross-cutting contract
   * that dozens of tests lean on, and a package should not widen it mid-wave —
   * and guarded the same property inside `resolveCacheMode` instead. With the
   * wave merged, it belongs here too.
   *
   * The reason is not tidiness. Without Redis every replica runs a
   * process-local token bucket, so N replicas grant N times the configured LLM
   * rate and N times the sandbox capacity. That is a bill and an outage, not a
   * degradation — and it is invisible until it happens.
   */
  "REDIS_URL",
] as const;

/**
 * What the LDAPS identity driver cannot start without. No default is possible
 * for any of them: they are facts about the bank's directory, and a guessed
 * base DN does not fail — it silently finds nobody.
 */
const REQUIRED_FOR_LDAP = ["LDAP_URL", "LDAP_USER_BASE_DN", "LDAP_BIND_DN"] as const;

/**
 * What each production requirement is FOR, in one clause.
 *
 * An operator staring at `VAULT_ADDR: required in production` knows a name and
 * nothing else — not which system it points at, not why the process would rather
 * die than start without it. The bank bundle made this concrete: four blank
 * endpoints produced four lines that named variables the operator had never
 * heard of, in a file where three of them sat commented out. Naming the variable
 * is the minimum; saying what fills it is what turns the error into an action.
 */
const PROD_REQUIREMENT_PURPOSE: Record<(typeof REQUIRED_IN_PROD)[number], string> = {
  DATABASE_URL: "the Postgres the schema and every run record live in",
  TEMPORAL_ADDRESS: "the Temporal frontend the workflows are scheduled on",
  JIRA_BASE_URL: "the Jira the work port reads and writes tickets against",
  ADO_BASE_URL: "the Azure DevOps / TFS collection the source and CI ports use",
  VAULT_ADDR: "the Vault the `prod` profile resolves every secret reference from",
  STORAGE_ENDPOINT: "the S3-compatible endpoint evidence documents are written to",
  REDIS_URL:
    "the Redis every replica shares its rate limits and capacity semaphore through — " +
    "without it each replica silently grants the full quota on its own",
};

export class EnvValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`environment validation failed:\n- ${issues.join("\n- ")}`);
    this.name = "EnvValidationError";
  }
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new EnvValidationError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  }
  const env = parsed.data;
  const issues: string[] = [];

  if (env.NODE_ENV === "production") {
    for (const k of REQUIRED_IN_PROD) {
      if (env[k] === undefined) {
        issues.push(
          `${k}: required in production (M6 fail-closed) — ${PROD_REQUIREMENT_PURPOSE[k]}. ` +
            "Set it, or leave production: an empty value counts as unset.",
        );
      }
    }
  }

  /**
   * The LDAPS driver's own required set (M8).
   *
   * Checked whenever the driver is SELECTED rather than only in production, so
   * a half-configured directory fails at boot on a developer's machine too —
   * the alternative is discovering it at the first login attempt, which is
   * both later and harder to read.
   */
  if (env.IDENTITY_DRIVER === "ldaps-bind") {
    for (const k of REQUIRED_FOR_LDAP) {
      if (env[k] === undefined) {
        issues.push(`${k}: required when IDENTITY_DRIVER=ldaps-bind`);
      }
    }
    /**
     * TLS is enforced here as well as inside the driver. Two checks because
     * this one runs at BOOT with nothing else configured, and catches the
     * deployment before it ever serves a login form.
     */
    if (env.NODE_ENV === "production" && env.LDAP_URL?.startsWith("ldaps://") === false) {
      issues.push(
        "LDAP_URL: must be ldaps:// in production — a plain ldap:// bind sends the user's " +
          "corporate password in cleartext",
      );
    }
    if (env.NODE_ENV === "production" && env.LDAP_ALLOW_INSECURE) {
      issues.push("LDAP_ALLOW_INSECURE: must not be true in production");
    }
  }

  if (issues.length > 0) throw new EnvValidationError(issues);
  return env;
}
