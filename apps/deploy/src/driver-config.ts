import { NO_ENDPOINT_CONFIGURED } from "@maestro/llm-gateway";
import type { DeployEnv } from "./env.js";
import { vaultMounts } from "./env.js";
import { objectLockConfig } from "./object-lock.js";
import { NOT_CONFIGURED_DRIVER, type PortKey, type Profile } from "./profile.js";

/**
 * Per-port driver configuration, built from the environment.
 *
 * These are the `config` halves of `PortSelection` — declarative objects each
 * driver validates with its own Zod schema. Nothing here contains a secret
 * VALUE: every credential appears as a reference the driver resolves through
 * the SecretPort at call time (M80). That is what makes it safe for
 * `logWiring` to print a summary of this at boot.
 */

export class DeployConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployConfigError";
  }
}

function required<T>(value: T | undefined, name: string, why: string): T {
  if (value === undefined) {
    throw new DeployConfigError(`${name}: ${why}`);
  }
  return value;
}

export function jiraConfig(env: DeployEnv, secrets: unknown, fetchImpl?: unknown): Record<string, unknown> {
  return {
    baseUrl: required(env.base.JIRA_BASE_URL, "JIRA_BASE_URL", "the work port has no default instance"),
    tokenRef: env.JIRA_TOKEN_REF,
    webhookSecretRef: env.JIRA_WEBHOOK_SECRET_REF,
    // `fetchImpl` is the TLS-aware transport the composition root builds
    // (`tlsAwareFetchWith`) — a Jira DC behind the bank's own CA follows the
    // same skip rule the panel's probe applied when its test went green.
    // Absent, the adapter falls back to the global fetch exactly as before.
    deps: { secrets, ...(fetchImpl === undefined ? {} : { fetchImpl }) },
  };
}

/**
 * Jira Cloud's config, from the same `JIRA_CLOUD_*` variables the pilot reads.
 *
 * Cloud authenticates with HTTP Basic — the token owner's e-mail as username,
 * an Atlassian API token as password — so it needs an address the Data Center
 * config has no field for. Reusing the pilot's variable names is deliberate:
 * a deployment that already runs the pilot against a Cloud site must not have
 * to restate the same three facts under new names to run the workflow engine
 * against it.
 *
 * The token reaches the port as a SecretPort REFERENCE, never a value. The
 * env-file secret driver resolves `env:JIRA_CLOUD_API_TOKEN` back to the
 * variable, which keeps this identical in shape to the Vault-backed path a
 * bank would use.
 */
export function jiraCloudConfig(env: DeployEnv, secrets: unknown, fetchImpl?: unknown): Record<string, unknown> {
  const read = (name: string): string | undefined => {
    const value = env.source[name];
    return value === undefined || value.trim() === "" ? undefined : value;
  };
  return {
    baseUrl: required(
      read("JIRA_CLOUD_BASE_URL") ?? env.base.JIRA_BASE_URL,
      "JIRA_CLOUD_BASE_URL",
      "the Jira Cloud work port has no default site",
    ),
    // The bot identity is what posts and transitions; the personal token is the
    // documented fallback (see apps/pilot/src/env.ts) and the same order applies
    // here so both engines act as the same Jira user.
    email: required(
      read("MAESTRO_BOT_EMAIL") ?? read("JIRA_CLOUD_EMAIL"),
      "JIRA_CLOUD_EMAIL",
      "Cloud authenticates with the token owner's e-mail",
    ),
    // A SecretPort key, not a variable name: `<mount>/<path>[#<field>]`
    // (packages/secrets/src/keys.ts). The env-file driver maps it back to
    // `MAESTRO_SECRET_KV_JIRA__TOKEN`; a Vault deployment reads the same key
    // from its own mount, which is the point of naming secrets this way.
    apiTokenRef: env.JIRA_TOKEN_REF ?? "kv/jira#token",
    webhookSecretRef: env.JIRA_WEBHOOK_SECRET_REF,
    // Same TLS-aware transport seam as `jiraConfig` — see the note there.
    deps: { secrets, ...(fetchImpl === undefined ? {} : { fetchImpl }) },
  };
}

/**
 * The GitHub `scm` config — the driver every deployment composes.
 *
 * It asks the operator for NOTHING. `mode: cloud` defaults both endpoints to
 * github.com (`packages/adapter-github/src/config.ts`), so the whole config is
 * a secret reference with a default, and the port therefore builds on a stack
 * where nobody has configured a repository yet. That is deliberate and it is
 * the difference this file is here to make: a port that composes can be ASKED
 * whether it works, and a wizard can report the answer before an operator
 * commits to a flow. A port that refused at composition time could only be
 * discovered by a run that had already written and published an analysis.
 *
 * Having no credential is not the same as having a broken one. The driver
 * resolves `tokenRef` lazily, at the first call, so an install with no GitHub
 * token still boots and still runs the analysis line end to end — the
 * engineering steps are the only ones that ever ask for it.
 *
 * `GITHUB_API_BASE_URL`/`GITHUB_GRAPHQL_URL` are for GitHub Enterprise Server,
 * where there is no default to guess: the pair travels together, and naming one
 * without the other is refused by the driver's own schema rather than by a
 * silent fallback to github.com — a bank's on-premise GitHub is exactly the
 * deployment that must not quietly reach the internet instead.
 */
export function githubConfig(env: DeployEnv): Record<string, unknown> {
  const read = (name: string): string | undefined => {
    const value = env.source[name];
    return value === undefined || value.trim() === "" ? undefined : value.trim();
  };
  const apiBaseUrl = read("GITHUB_API_BASE_URL");
  const graphqlUrl = read("GITHUB_GRAPHQL_URL");
  const tokenRef = read("GITHUB_TOKEN_REF") ?? "kv/github#token";
  if (apiBaseUrl === undefined && graphqlUrl === undefined) {
    return { mode: "cloud", tokenRef };
  }
  return {
    mode: "enterprise",
    apiBaseUrl: required(
      apiBaseUrl,
      "GITHUB_API_BASE_URL",
      "GITHUB_GRAPHQL_URL names an enterprise GitHub, so its REST root must be named too",
    ),
    graphqlUrl: required(
      graphqlUrl,
      "GITHUB_GRAPHQL_URL",
      "GITHUB_API_BASE_URL names an enterprise GitHub, so its GraphQL root must be named too",
    ),
    tokenRef,
  };
}

/**
 * ADO serves both the `scm` and the `ci` port from one config.
 *
 * `ci.prValidationBuilds` is an allow-list the driver refuses to leave empty:
 * without it any pipeline in the organisation could answer for a pull
 * request's validation gate (M12). It therefore has no default here either —
 * an operator must name the definitions, and the failure to do so is a startup
 * error rather than a gate that quietly accepts everything.
 */
export function adoConfig(env: DeployEnv): Record<string, unknown> {
  const baseUrl = required(env.base.ADO_BASE_URL, "ADO_BASE_URL", "the scm/ci ports have no default instance");
  const org = required(env.ADO_ORG, "ADO_ORG", "required to address the Azure DevOps collection");
  const project = required(env.ADO_PROJECT, "ADO_PROJECT", "required by the CI allow-list");
  return {
    mode: "services",
    org,
    baseUrl,
    tokenRef: env.ADO_TOKEN_REF,
    ci: {
      webhookSecretRef: env.ADO_WEBHOOK_SECRET_REF,
      webhookUsername: env.ADO_WEBHOOK_USERNAME,
      prValidationBuilds: parsePrValidationBuilds(env, project),
    },
  };
}

/**
 * `ADO_PR_VALIDATION_BUILDS` as `repo:definitionId` pairs, comma separated.
 * A malformed entry is refused rather than skipped: silently dropping one
 * would shrink the allow-list, and a shrunken allow-list looks exactly like a
 * gate that never opens.
 */
export function parsePrValidationBuilds(
  env: DeployEnv,
  project: string,
): { project: string; repository: string; definitionId: number }[] {
  const raw = env.ADO_PR_VALIDATION_BUILDS;
  if (raw === undefined || raw.trim() === "") {
    throw new DeployConfigError(
      "ADO_PR_VALIDATION_BUILDS: required — the CI gate needs an explicit allow-list of " +
        'PR-validation definitions ("repo:definitionId", comma separated); an empty list is refused, not "allow all" (M12)',
    );
  }
  return raw.split(",").map((entry) => {
    const trimmed = entry.trim();
    const separator = trimmed.lastIndexOf(":");
    const repository = separator === -1 ? "" : trimmed.slice(0, separator).trim();
    const definitionId = Number(trimmed.slice(separator + 1));
    if (repository === "" || !Number.isInteger(definitionId) || definitionId <= 0) {
      throw new DeployConfigError(
        `ADO_PR_VALIDATION_BUILDS: "${trimmed}" is not a "repo:definitionId" pair with a positive integer id`,
      );
    }
    return { project, repository, definitionId };
  });
}

/**
 * Storage config. The two drivers take different shapes and neither is a
 * degraded version of the other, so the profile picks one outright.
 *
 * `s3-compat` needs the access key as a VALUE, not a reference — SigV4 signs
 * with the key material itself. It is therefore resolved from the SecretPort
 * by the caller and passed in, which is why this function takes credentials
 * rather than reading them.
 *
 * BOTH drivers carry `objectLock` (M56/M57). Neither did until an analysis ran
 * to completion in the `analiz` profile and attached nothing: the `docx` target
 * asks for a locked put, an unconfigured driver refuses it rather than writing
 * an unprotected record, and the document was lost to a fail-soft branch. The
 * configuration is what was missing — the refusal was correct.
 *
 * On `s3-compat` the headers only INSTRUCT the endpoint: the bucket must itself
 * have Object Lock enabled at CREATION time, which no client call can do after
 * the fact. That is an operator prerequisite, not a gap this code can close —
 * and a bucket lacking it answers the locked put with a 400 rather than storing
 * an unprotected object, so prod fails loudly instead of the other way round.
 */
export function storageConfig(
  env: DeployEnv,
  profile: Profile,
  s3Credentials?: { accessKeyId: string; secretAccessKey: string },
  sql?: unknown,
  fetchImpl?: unknown,
): Record<string, unknown> {
  if (profile === "prod") {
    const credentials = required(s3Credentials, "STORAGE credentials", "the s3-compat driver signs with key material");
    return {
      endpoint: required(env.base.STORAGE_ENDPOINT, "STORAGE_ENDPOINT", "the s3-compat driver has no default endpoint"),
      region: env.STORAGE_REGION,
      bucket: env.STORAGE_BUCKET,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      objectLock: objectLockConfig(env, profile),
      fetch: fetchImpl ?? globalThis.fetch,
    };
  }
  return {
    table: "storage_blob",
    objectLock: objectLockConfig(env, profile),
    sql: required(sql, "storage sql executor", "the pg-blob driver writes through an injected SqlExecutor"),
  };
}

/**
 * The LLM gateway.
 *
 * `onPremMissing: "degrade_ai_assist"` is the driver's own default and the
 * only honest one for a bank: when no on-prem model is reachable, the platform
 * stops offering AI assistance rather than shipping a `gizli` payload to a
 * cloud endpoint. The demo overrides it to `masked_cloud` because it has no
 * on-prem model at all; a real deployment must not inherit that choice, so it
 * is left at the default here deliberately.
 */
/** The CLI-backed agent-session driver, as `@maestro/claude-driver` registers it. */
const AGENT_DRIVER = "claude-sub";

/**
 * The seat that is the machine's own interactive `claude login`.
 *
 * Shaped as a SecretPort key because the subscription pool's schema demands
 * one, but never resolved as a secret: `buildAgentRunner` matches this exact
 * value and returns a seat with `oauthToken: null`, which is how the CLI reads
 * the login already on the host. A bank names a real key instead
 * (`CLAUDE_SEAT_REF=kv/claude#seat1`) and the token comes from Vault.
 */
export const LOCAL_SEAT_REF = "kv/claude#local-login";

/**
 * Whether this deployment can run agent sessions at all.
 *
 * The same condition `buildAgentRunner` uses: an operator who has not named a
 * CLI binary gets no `claude-sub` driver, no binding to it and no route
 * through it — rather than a configuration that promises a session backend the
 * process cannot build.
 */
function agentDriverAvailable(env: DeployEnv): boolean {
  const bin = env.source["CLAUDE_BIN_PATH"]?.trim();
  return bin !== undefined && bin !== "";
}

/** Drivers a data class may be routed to, agent driver included when present. */
function allowed(env: DeployEnv, driver: string): string[] {
  return agentDriverAvailable(env) ? [driver, AGENT_DRIVER] : [driver];
}

/**
 * A placeholder endpoint for an install that names none — NEVER DIALLED.
 *
 * The driver's schema demands a syntactically valid URL to build at all, and a
 * stack configured entirely from the panel has no address to give it at
 * composition time — the panel is how one is added, so boot cannot demand it.
 *
 * The constant itself lives in `@maestro/llm-gateway` (`model-source.ts`),
 * because the gateway is what must RECOGNIZE it: when the panel has no row it
 * falls back to this static value only if it is a real endpoint, and raises
 * `ModelNotConfiguredError` by name instead of dialling the placeholder. Two
 * copies of the string would let the two decisions drift apart silently. The
 * gateway's copy also carries the RFC 2606 `.invalid` rationale.
 */

export function llmConfig(env: DeployEnv): Record<string, unknown> {
  /**
   * The endpoint is no longer REQUIRED here.
   *
   * It used to be, and that was the wall: `required()` threw at composition
   * time, so a stack could not boot without `LLM_BASE_URL` — which meant the
   * panel could never be the place a model is added, because the process had to
   * be told about one before it would start and serve the panel. Same reasoning
   * that gave the `work` port a not-configured driver rather than a boot
   * refusal, and the same consequence: the gap surfaces at first USE, named,
   * instead of as a process that will not start.
   *
   * An install that still names the variable keeps using it verbatim — the
   * value below feeds the driver exactly as before, and `resolveModel` simply
   * finds no row to override it with.
   */
  const baseUrl = env.LLM_BASE_URL ?? NO_ENDPOINT_CONFIGURED;
  const driver = "openai-compat";
  return {
    /**
     * Two kinds of backend, because there are two kinds of call.
     *
     * `openai-compat` answers a single request: intake's verdict, the analysis
     * document. Any OpenAI-shaped endpoint serves it, which is what makes the
     * on-prem story a URL change.
     *
     * An agent SESSION is not that. Steps 3ö and 6a hand a model a working
     * directory and let it read, search and edit across many turns, and that
     * is a CLI running beside the repository rather than a chat completion.
     * `claude-sub` is the driver for it, and it only exists when the operator
     * has named a binary (`CLAUDE_BIN_PATH`) — absent it, the session steps
     * refuse with `AgentRunnerNotWiredError` and everything else still runs.
     */
    drivers: [
      {
        driver,
        baseUrl,
        apiKeyRef: env.LLM_API_KEY_REF,
        onPrem: env.LLM_ON_PREM,
        timeoutMs: 90_000,
      },
      // `claude-sub` is deliberately NOT listed here. This array configures HTTP
      // backends — base URL, API key, timeout — and the gateway's schema is a
      // discriminated union over the four it knows how to call. An agent session
      // is not an HTTP call the gateway makes: it is a CLI the injected
      // `AgentRunner` spawns, which holds its own endpoint and seat credential.
      // The driver name only has to appear in the binding and the route below,
      // which is what `policy.resolve` reads.
    ],
    bindings: [
      { role: "intake", driver, model: env.LLM_MODEL },
      { role: "analyst", driver, model: env.LLM_MODEL },
      // `engineer` is the role an agent session runs under (`agentRole`), so it
      // binds to the CLI driver when there is one.
      {
        role: "engineer",
        driver: agentDriverAvailable(env) ? AGENT_DRIVER : driver,
        model: env.source["CLAUDE_MODEL"]?.trim() ?? env.LLM_MODEL,
      },
    ],
    /**
     * The seat the CLI runs on (M55).
     *
     * An agent session goes through a subscription account rather than a
     * metered API key, so the gateway tracks it as quota rather than dollars —
     * which is also why `LlmCall.usd` is null for these rows.
     */
    ...(agentDriverAvailable(env)
      ? {
          subscriptionPool: {
            accounts: [
              {
                accountId: env.source["CLAUDE_SEAT_ID"]?.trim() ?? "claude-seat-1",
                driver: AGENT_DRIVER,
                // How the seat authenticates underneath. The CLI holds the
                // credential; this names the shape for the pool's bookkeeping.
                transport: driver,
                // A SecretPort key (`<mount>/<path>[#<field>]`), because the
                // pool's schema requires one and the port parses it. A
                // deployment whose seat is the machine's own `claude login`
                // has no secret to name — `buildAgentRunner` recognises this
                // key and resolves it to the interactive session instead of
                // asking the SecretPort for a value nobody stored.
                credentialRef: env.source["CLAUDE_SEAT_REF"]?.trim() ?? LOCAL_SEAT_REF,
                windows: [{ kind: "5h", costPctPerCall: 1 }],
              },
            ],
          },
        }
      : {}),
    /**
     * `gizli` is NOT routed to the seat, deliberately.
     *
     * A subscription account is an outside account: the gateway refuses to let
     * one serve the confidential class, and that refusal is the correct one to
     * keep. The consequence is worth stating plainly — a `gizli` ticket gets no
     * repository reading, because the only session backend this deployment has
     * is one a bank's confidential data may not reach. `discoverRepo` degrades,
     * the analysis is written from the ticket alone, and the run continues.
     */
    routes: [
      { dataClass: "acik", allowedDrivers: allowed(env, driver) },
      { dataClass: "dahili", allowedDrivers: allowed(env, driver) },
      { dataClass: "gizli", allowedDrivers: [driver] },
    ],
  };
}

/**
 * Scanner config.
 *
 * The image must be digest-pinned (M27) and the driver refuses anything else,
 * so there is no default to fall back on: a deployment that has not named a
 * scanner image has not decided what its gate measures. `SCAN_IMAGE_TRIVY`
 * names the one the profile selects; the other two tools are configured the
 * same way once they are selectable.
 */
export function scanConfig(env: DeployEnv, driver: string): Record<string, unknown> {
  // The not-configured driver reads no config: it has no container to pin,
  // because it never runs one. Demanding a digest from a deployment that has
  // not set a scanner up is the same wall `ADO_BASE_URL` was.
  if (driver === NOT_CONFIGURED_DRIVER) return {};
  const byTool: Record<string, string | undefined> = {
    trivy: env.SCAN_IMAGE_TRIVY,
    semgrep: env.SCAN_IMAGE_SEMGREP,
    gitleaks: env.SCAN_IMAGE_GITLEAKS,
  };
  const variable = `SCAN_IMAGE_${driver.toUpperCase()}`;
  const image = required(
    byTool[driver],
    variable,
    `required — the ${driver} gate needs a digest-pinned image; a tag can change under a passing gate (M27)`,
  );
  return { image };
}

/** Notification config; `multi` fans out, `jira` posts on the ticket. */
export function notifyConfig(profile: Profile): Record<string, unknown> {
  return profile === "prod" ? { jira: {} } : {};
}

/**
 * Publish config; `multi` needs the project's explicit target set (M47).
 *
 * The set is what the port can SERVE, not what a given document is published
 * to — that stays the `publish.targets` parameter each project owns, read per
 * run by `ParamReader.publishTargets`. The two are different questions, and
 * conflating them is what used to make `docx`/`pdf` unreachable: the port was
 * composed for `jira` alone, so the delivery step's request for a Word file
 * came back as `CapabilityNotSupportedError` no matter what the project had
 * configured.
 *
 * `docx`/`pdf` are therefore always in the servable set (M103r) — the analysis
 * document is the deliverable of the `analiz` release, and a deployment that
 * cannot render it to a file has nothing to hand the analyst.
 */
export function publishConfig(_profile: Profile): Record<string, unknown> {
  return { targets: ["jira", "docx", "pdf"] };
}

/** The secret driver's own config, so the registry can rebuild it by name. */
export function secretConfig(env: DeployEnv, profile: Profile, deps: unknown): Record<string, unknown> {
  const allowedMounts = vaultMounts(env);
  if (profile === "prod") {
    return { addr: env.base.VAULT_ADDR, allowedMounts, deps };
  }
  return { allowedMounts, deps: { nodeEnv: env.base.NODE_ENV } };
}

/** Every port's config in one map, keyed exactly like `PortSelection`. */
export type DriverConfigMap = Readonly<Record<PortKey, unknown>>;
