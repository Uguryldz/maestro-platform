import { loadEnv, type Env } from "@maestro/config";
import { z } from "zod";
import { parseProfile, type Profile } from "./profile.js";

/**
 * The deployment's own environment contract.
 *
 * `@maestro/config`'s `EnvSchema` owns the connection values every service
 * shares (`DATABASE_URL`, `TEMPORAL_ADDRESS`, the Jira/ADO/Vault/storage
 * endpoints) and is the source of truth for them — this module calls `loadEnv`
 * rather than restating any of it. What is added here is what only a deployment
 * knows: which profile to compose, which ports to listen on, and the secret
 * REFERENCES (never values) the drivers resolve.
 */

/** A Vault-style secret reference: `mount/path#field`. Never a secret value. */
const SecretRef = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\n"), "a secret reference is a single line");

/**
 * An optional setting, where compose's `""` means UNSET.
 *
 * `z.string().min(1).optional()` is wrong for anything compose passes as
 * `${VAR:-}`: that syntax delivers an EMPTY STRING, not an absent variable, so
 * `min(1)` fails and the whole process refuses to boot over a setting the
 * operator deliberately left blank. `RUNNER_IMAGE_LINUX` hit exactly this — the
 * worker is designed to start without a sandbox fleet and refuse only step 6a,
 * and an empty default would instead have taken the entire worker down at
 * startup.
 *
 * Trimmed before the test, so a variable set to spaces is unset too: whitespace
 * is what a here-doc or a copied `.env` line leaves behind, and it is never a
 * meaningful image reference or endpoint.
 */
function optionalSetting(): z.ZodType<string | undefined, unknown> {
  return z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }, z.string().min(1).optional());
}

export const DeployEnvSchema = z.object({
  MAESTRO_PROFILE: z.string().optional(),
  // `BFF_PORT` / `BFF_HOST` are NOT declared here: they belong to
  // `@maestro/config`'s `EnvSchema`, which is the source of truth for
  // everything more than one service reads. `listenAddress` below reads them
  // back off `env.base`. Restating them here would give the deployment a
  // second schema for the same variable — and the two would disagree on the
  // day one of them changed its default.
  TEMPORAL_NAMESPACE: z.string().min(1).default("default"),
  TEMPORAL_TASK_QUEUE: z.string().min(1).optional(),

  // ── secret references ───────────────────────────────────────────────────
  // The values live in Vault (prod) or in `MAESTRO_SECRET_*` variables (dev).
  // What travels through the environment here is only the pointer, which is
  // why these are safe to print in a log line and safe to commit in
  // `.env.example` (M80).
  JIRA_TOKEN_REF: SecretRef.default("kv/jira#token"),
  JIRA_WEBHOOK_SECRET_REF: SecretRef.default("kv/jira#webhook"),
  ADO_TOKEN_REF: SecretRef.default("kv/ado#token"),
  ADO_WEBHOOK_SECRET_REF: SecretRef.default("kv/ado#webhook"),
  LLM_API_KEY_REF: SecretRef.default("kv/llm#api-key"),
  /**
   * The AD/LDAPS service-account password (M8).
   *
   * It lives here with the other pointers rather than in `@maestro/config`'s
   * `EnvSchema` for the reason that schema's own comment gives: this file owns
   * the secret REFERENCES, and `secret-names.test.ts` derives the
   * `MAESTRO_SECRET_*` variable names from these defaults. A reference declared
   * anywhere else is a reference that test cannot see — and the symptom would
   * be the exact drift it exists to catch.
   */
  LDAP_BIND_PASSWORD_REF: SecretRef.default("kv/ldap#service-password"),

  // ── Vault AppRole (prod profile only) ───────────────────────────────────
  // The one bootstrap credential that cannot itself come from Vault. It is
  // required by `requireVaultApprole`, not by the schema, so the dev profile
  // does not have to invent one.
  // `optionalSetting()`, not `.min(1).optional()`: the bank compose forwards
  // these as `${VAULT_ROLE_ID:-}`, so a deployment with no Vault at all
  // delivers them as empty strings and `min(1)` refused to boot over
  // credentials that profile never reads. `requireVaultApprole` below is
  // what demands them, and it demands them only from the profile that uses
  // Vault; that is the check that should fire, and it names both variables.
  VAULT_ROLE_ID: optionalSetting(),
  VAULT_SECRET_ID: optionalSetting(),
  /**
   * KV mounts the deployment may read, comma separated (least privilege, M6).
   *
   * `git` is in the default alongside `kv` because the Vault driver issues the
   * short-lived push credential from it (M31): a mount list without it composes
   * happily and then denies every push at the first engineering turn.
   */
  VAULT_MOUNTS: z.string().min(1).default("kv,git"),

  // ── ADO topology ────────────────────────────────────────────────────────
  // Blank means unset, for the same reason as the Vault pair above: the scm
  // port is GitHub unless a deployment says otherwise, so nothing here is read
  // on most installs, yet compose still forwards `${ADO_ORG:-}` as an empty
  // string. The deployment that legitimately has no Azure DevOps must boot.
  ADO_ORG: optionalSetting(),
  ADO_PROJECT: optionalSetting(),
  ADO_WEBHOOK_USERNAME: z.string().min(1).default("maestro-ci"),
  /**
   * Allow-list of PR-validation build definitions, as `repo:definitionId`
   * pairs. The CI gate refuses an empty list rather than reading it as
   * "allow all" (M12), so this has no default.
   */
  ADO_PR_VALIDATION_BUILDS: z.string().optional(),

  // ── storage ─────────────────────────────────────────────────────────────
  STORAGE_BUCKET: z.string().min(1).default("maestro-evidence"),
  STORAGE_REGION: z.string().min(1).default("us-east-1"),

  // ── LLM ─────────────────────────────────────────────────────────────────
  /**
   * The model endpoint, when a deployment still names one in its environment.
   *
   * BLANKABLE, and that is the trap this shape exists to defuse. Compose passes
   * an unset variable as `${LLM_BASE_URL:-}` — an EMPTY STRING, not an absent
   * key — and `z.string().url()` rejects `""`, so the whole process would refuse
   * to boot over a setting the operator deliberately left blank now that the
   * panel owns it. `BlankableUrl` in `@maestro/config` exists because this exact
   * trap already broke a boot once; the same preprocessing is applied here.
   *
   * No longer REQUIRED anywhere: a model is added from the panel, and a stack
   * with neither a variable nor a row boots and refuses at first use by name.
   */
  LLM_BASE_URL: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().url().optional(),
  ),
  /**
   * Blank-tolerant for the same reason, and the default is what a binding needs
   * to PARSE — the gateway's schema demands a non-empty model on every binding.
   * A panel row overrides it per call; absent a row this is what is dialled,
   * which keeps an install configured only in `.env` working exactly as before.
   */
  LLM_MODEL: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().min(1).default("gpt-4o-mini"),
  ),
  LLM_ON_PREM: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),

  // ── scanning ────────────────────────────────────────────────────────────
  DOCKER_SOCKET_PATH: z.string().min(1).default("/var/run/docker.sock"),
  /**
   * Scanner images, DIGEST-PINNED (M27). A tag is a moving target: the same
   * `trivy:latest` that passed a gate on Monday can be a different binary on
   * Tuesday, and a scan gate whose scanner can change without a deployment is
   * not evidence of anything. The driver's own schema refuses an unpinned
   * reference, so these have no default — the deployment must name a digest.
   */
  SCAN_IMAGE_TRIVY: optionalSetting(),
  SCAN_IMAGE_SEMGREP: optionalSetting(),
  SCAN_IMAGE_GITLEAKS: optionalSetting(),

  // ── the engineering turn's sandbox fleet (M21/M23/M60) ──────────────────
  /**
   * The image an engineering turn's sandbox runs in, DIGEST-PINNED — same
   * rule and same reason as the scanner images above. It has no default: the
   * runner's schema refuses an unpinned reference, and a build environment
   * that can change without a deployment makes every verification result
   * unreproducible.
   *
   * Absent, the worker keeps a NARROWED refusal for the engineering turn (see
   * `buildTurnRunner` in bin/worker.ts) rather than inventing a fleet.
   */
  RUNNER_IMAGE_LINUX: optionalSetting(),
  /**
   * The Docker network the sandbox joins (M26).
   *
   * Must be `Internal: true`; the driver inspects it and refuses otherwise, so
   * a misnamed network fails closed. Absent, the sandbox joins the daemon's
   * DEFAULT bridge — which reaches the internet, and an agent session reading a
   * bank's repository must not. Name one for any deployment that runs the
   * sandbox: `docker network create --internal maestro-sandbox`.
   */
  RUNNER_NETWORK: optionalSetting(),
  /**
   * Sandbox hardening an operator has deliberately switched off, comma-separated
   * (`readonly-rootfs`, `no-new-privileges`, `cap-add`, `seccomp`,
   * `direct-egress`).
   *
   * The runner's own schema refuses every one of them when the process runs in
   * production, so this cannot weaken a bank deployment — it exists so a
   * development stack can run the sandbox without standing up an egress proxy
   * first. Anything named here is stated, not inherited.
   */
  RUNNER_ALLOW_UNSAFE: optionalSetting(),
  /**
   * M23 budget for one verification command. The runner enforces its own
   * ceiling on top of this, so a value above it is refused rather than
   * silently clamped.
   */
  RUNNER_COMMAND_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(86_400).default(1_800),
});

export type DeployEnvRaw = z.infer<typeof DeployEnvSchema>;

export class DeployEnvError extends Error {
  constructor(readonly issues: string[]) {
    super(`deployment environment validation failed:\n- ${issues.join("\n- ")}`);
    this.name = "DeployEnvError";
  }
}

export interface DeployEnv extends DeployEnvRaw {
  /** The shared connection values, validated by `@maestro/config` (M6). */
  readonly base: Env;
  readonly profile: Profile;
  /**
   * The variables this env was read from.
   *
   * Carried so that driver configs can reach names outside the shared schema —
   * Jira Cloud's `JIRA_CLOUD_*` triple, for one — without importing
   * `process.env` themselves. A module that reads the global directly is a
   * module no test can point at a different environment, and the deployment
   * tests do exactly that.
   */
  readonly source: Record<string, string | undefined>;
}

/**
 * Validate the whole environment, base contract first.
 *
 * Order matters: `loadEnv` is what refuses a production process with no
 * `DATABASE_URL`, so it runs before anything here can paper over the gap with a
 * default. Both layers throw; neither returns a half-built object.
 */
export function loadDeployEnv(source: Record<string, string | undefined> = process.env): DeployEnv {
  const base = loadEnv(source);
  const parsed = DeployEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new DeployEnvError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }
  // The profile defaults to the one that matches NODE_ENV rather than to a
  // fixed literal: an operator who sets NODE_ENV=production and forgets
  // MAESTRO_PROFILE gets the Vault-backed stack, not a silent env-file one.
  const requested = parsed.data.MAESTRO_PROFILE ?? (base.NODE_ENV === "production" ? "prod" : "dev");
  const profile = parseProfile(requested);
  assertProfileMatchesNodeEnv(profile, base.NODE_ENV);
  return { ...parsed.data, base, profile, source };
}

/**
 * The dev profile keeps secrets in environment variables and blobs in
 * Postgres. Composing it inside a production process would put a bank's
 * credentials in `/proc/<pid>/environ`, so it is refused here — early, and by
 * name — rather than left to the env-file driver's own production guard, which
 * would only fire at the first secret read, several services into a boot.
 */
export function assertProfileMatchesNodeEnv(profile: Profile, nodeEnv: Env["NODE_ENV"]): void {
  if (profile === "dev" && nodeEnv === "production") {
    throw new DeployEnvError([
      'MAESTRO_PROFILE: the "dev" profile resolves secrets from environment variables and ' +
        'must not run with NODE_ENV=production — use the "prod" profile (M80)',
    ]);
  }
}

export interface VaultApprole {
  readonly roleId: string;
  readonly secretId: string;
}

/**
 * The Vault AppRole, required by the prod profile.
 *
 * The error names the variables and nothing else. `VAULT_SECRET_ID` IS a
 * credential — the one secret that cannot be fetched from the secret store —
 * so it must never reach a message, a log line or a stack frame that gets
 * serialised (this is the leak the sandbox round found).
 */
export function requireVaultApprole(env: DeployEnv): VaultApprole {
  const missing: string[] = [];
  if (env.VAULT_ROLE_ID === undefined) missing.push("VAULT_ROLE_ID");
  if (env.VAULT_SECRET_ID === undefined) missing.push("VAULT_SECRET_ID");
  if (missing.length > 0) {
    throw new DeployEnvError(
      missing.map((name) => `${name}: required by the "prod" profile — Vault login has no default (M6/M80)`),
    );
  }
  return { roleId: env.VAULT_ROLE_ID as string, secretId: env.VAULT_SECRET_ID as string };
}

export interface ListenAddress {
  readonly host: string;
  readonly port: number;
}

/**
 * Where the BFF binds.
 *
 * Both values come from `@maestro/config`'s `EnvSchema`, which owns them. The
 * default host there is loopback DELIBERATELY: a service that binds `0.0.0.0`
 * because a variable was forgotten is a service exposed to the network by
 * omission. Inside a container loopback is useless, so `compose.yaml` sets
 * `BFF_HOST=0.0.0.0` explicitly — the exposure is then a decision somebody
 * wrote down, which is the whole point of the loopback default.
 *
 * Read structurally off `env.base` rather than through a typed field so this
 * keeps compiling either side of the `EnvSchema` change that adds them.
 */
export function listenAddress(env: DeployEnv): ListenAddress {
  const base = env.base as Record<string, unknown>;
  const port = base["BFF_PORT"];
  const host = base["BFF_HOST"];
  return {
    host: typeof host === "string" && host.length > 0 ? host : "127.0.0.1",
    port: typeof port === "number" ? port : 7001,
  };
}

/** Vault mounts the deployment may read, as the driver's config expects them. */
export function vaultMounts(env: DeployEnv): string[] {
  return env.VAULT_MOUNTS.split(",")
    .map((mount) => mount.trim())
    .filter((mount) => mount.length > 0);
}
