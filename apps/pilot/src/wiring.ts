import { createAdoCiDriver, createAdoScmDriver, type AdoCiDriver, type AdoScmDriver } from "@maestro/adapter-ado";
import { createGithubScmDriver, type FetchLike as GithubFetchLike } from "@maestro/adapter-github";
import {
  createJiraCloudWorkPort,
  type FetchLike,
  type JiraCloudWorkPort,
} from "@maestro/adapter-jira";
import type { ScmPort } from "@maestro/ports";
import { AuditChain, InMemoryAuditStore } from "@maestro/audit";
import type { LlmCallLog } from "@maestro/contracts";
import { createLlmGateway, type LlmGateway } from "@maestro/llm-gateway";
import {
  defaultPiiPolicy,
  maskOutbound,
  type LoadedPiiPolicy,
  type MaskCounts,
} from "@maestro/pii";
import type { SecretPort } from "@maestro/ports";
import { EnvFileConfig, EnvFileSecretPort, envVarName, parseSecretKey } from "@maestro/secrets";
import {
  ADO_ORG,
  ADO_PR_VALIDATION_DEFINITION,
  ADO_PROJECT,
  ADO_REPO,
  ADO_WEBHOOK_USERNAME,
  GITHUB_PUSH_TTL_SECONDS,
  PILOT_MODEL,
  PILOT_SECRETS,
  SECRET_REFS,
} from "./config.js";
import type { GithubEnv, JiraCloudEnv, OpenRouterEnv } from "./env.js";
import { resolveGithub, resolveJiraCloud, resolveOpenRouter } from "./env.js";

/**
 * Composition root of the pilot. Every port below is the REAL package driver.
 * Unlike the demo, the Jira WorkPort points at the LIVE site — the only fake
 * left is ADO. Nothing here holds a secret VALUE except the seed record built
 * once in `createPilotSecrets`; the drivers resolve references through the
 * SecretPort, exactly as the composition root of the real BFF would (M44/M80).
 */

/**
 * Environment-variable name for a secret reference, using the driver's own
 * mapping rather than a re-implementation of it — the two must not drift.
 */
function envName(reference: string): string {
  return envVarName(parseSecretKey(reference), "MAESTRO_SECRET_");
}

/**
 * SecretPort for the pilot: the real `env-file` driver, fed from an in-memory
 * record rather than `process.env`, so neither the OpenRouter key nor the live
 * Jira token lands in the environment of any child process the pilot spawns.
 * The live Jira token is seeded here from `jiraCloud.apiToken` and NEVER logged.
 */
export function createPilotSecrets(
  openRouter: OpenRouterEnv,
  jiraCloud: JiraCloudEnv,
  github?: GithubEnv,
): SecretPort {
  const env: Record<string, string> = {
    [envName(SECRET_REFS.jiraCloud)]: jiraCloud.apiToken,
    [envName(SECRET_REFS.adoPat)]: PILOT_SECRETS.adoPat,
    [envName(SECRET_REFS.adoWebhook)]: PILOT_SECRETS.adoWebhook,
    [envName(SECRET_REFS.openrouter)]: openRouter.apiKey,
    // The GitHub token is seeded ONLY when the github SCM edge is active; the
    // fake path never carries it, so the default pilot holds no GitHub secret.
    ...(github ? { [envName(SECRET_REFS.github)]: github.token } : {}),
  };
  return new EnvFileSecretPort({
    config: EnvFileConfig.parse({ allowedMounts: ["kv"], cacheTtlSeconds: 0 }),
    env,
    nodeEnv: "development",
  });
}

export interface MaskEvent {
  counts: MaskCounts;
  boundary: string;
  leg: "request" | "response";
}

export interface GatewayHooks {
  onCallLog?: (log: LlmCallLog) => void;
  onMasked?: (event: MaskEvent) => void;
  runId?: () => string | null;
  /** Injected transport; tests use it to keep the gateway offline. */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

/**
 * The model each thinking role binds to, resolved DB-first at boot (M38).
 *
 * `analyst` and `engineer` come from their VARIANT's active version (or the env
 * fallback when no store is wired); `intake` shares the analyst's model — intake
 * is the analyst's first pass, not a separately configured agent. Every field
 * defaults to `PILOT_MODEL` so an offline test that does not resolve variants
 * keeps the exact old behaviour.
 */
export interface RoleModels {
  intake?: string;
  analyst?: string;
  engineer?: string;
}

/**
 * The LLM gateway over OpenRouter's OpenAI-compatible API. Identical posture to
 * the demo: `onPremMissing: "masked_cloud"` with a `gizli` data class masks the
 * payload through `@maestro/pii` before anything leaves the machine and
 * re-scans the result before it is sent (M18/M20).
 */
export function createPilotGateway(
  secrets: SecretPort,
  openRouter: OpenRouterEnv,
  hooks: GatewayHooks = {},
  models: RoleModels = {},
): { gateway: LlmGateway; policy: LoadedPiiPolicy } {
  const policy = defaultPiiPolicy();
  // Each role's model is the DB-resolved one when boot passed it, else the
  // bootstrap PILOT_MODEL. This is the seam that makes the pilot run on the
  // model an admin set on the variant in Studio, not on an env constant.
  const analystModel = models.analyst ?? PILOT_MODEL;
  const engineerModel = models.engineer ?? PILOT_MODEL;
  const intakeModel = models.intake ?? analystModel;
  const gateway = createLlmGateway(
    {
      drivers: [
        {
          driver: "openai-compat",
          baseUrl: openRouter.baseUrl,
          apiKeyRef: SECRET_REFS.openrouter,
          onPrem: false,
          timeoutMs: 90_000,
        },
      ],
      bindings: [
        { role: "intake", driver: "openai-compat", model: intakeModel },
        { role: "analyst", driver: "openai-compat", model: analystModel },
        { role: "engineer", driver: "openai-compat", model: engineerModel },
      ],
      routes: [
        { dataClass: "acik", allowedDrivers: ["openai-compat"] },
        { dataClass: "dahili", allowedDrivers: ["openai-compat"] },
        { dataClass: "gizli", allowedDrivers: ["openai-compat"] },
      ],
      onPremMissing: "masked_cloud",
      maxTokens: 3_000,
      temperature: 0,
      retry: { maxAttempts: 2, baseDelayMs: 400, maxDelayMs: 2_000 },
    },
    {
      secrets,
      piiPolicy: policy,
      mask: (payload, context) =>
        maskOutbound(payload, {
          policy,
          dataClass: context.dataClass,
          boundary: context.boundary,
          onMasked: (counts, _dataClass, info) =>
            hooks.onMasked?.({ counts, boundary: info.boundary, leg: info.leg }),
        }),
      ...(hooks.onCallLog ? { onCallLog: hooks.onCallLog } : {}),
      ...(hooks.runId ? { runId: hooks.runId } : {}),
      ...(hooks.fetchImpl ? { fetchImpl: hooks.fetchImpl } : {}),
    },
  );
  return { gateway, policy };
}

/**
 * The LIVE Jira Cloud WorkPort — this is the whole point of the pilot. It talks
 * to `jiraCloud.baseUrl` over REST v3 with Basic auth (email + API token
 * resolved through the SecretPort). `fetchImpl` is injected so tests stay
 * offline; in the running app it is the global fetch (undefined → driver uses it).
 */
export function createPilotWorkPort(
  secrets: SecretPort,
  jiraCloud: JiraCloudEnv,
  fetchImpl?: FetchLike,
): JiraCloudWorkPort {
  return createJiraCloudWorkPort({
    baseUrl: jiraCloud.baseUrl,
    email: jiraCloud.email,
    apiTokenRef: SECRET_REFS.jiraCloud,
    requestTimeoutMs: 15_000,
    deps: { secrets, ...(fetchImpl ? { fetchImpl } : {}) },
  });
}

function adoConfig(adoBaseUrl: string): Record<string, unknown> {
  return {
    mode: "services",
    org: ADO_ORG,
    baseUrl: adoBaseUrl,
    // Localhost props speak plain HTTP; the driver demands an explicit opt-in.
    allowInsecureHttp: true,
    tokenRef: SECRET_REFS.adoPat,
    ci: {
      webhookSecretRef: SECRET_REFS.adoWebhook,
      webhookUsername: ADO_WEBHOOK_USERNAME,
      prValidationBuilds: [
        { project: ADO_PROJECT, repository: ADO_REPO, definitionId: ADO_PR_VALIDATION_DEFINITION },
      ],
    },
  };
}

/**
 * The pilot's ScmPort. `fake` (default) is the unchanged ADO driver against the
 * fake ADO with `issueSecret` throwing — no push. `github` is the REAL GitHub
 * driver: real branch, real PR, and a real short-lived push credential minted
 * on demand (so the engineer step can `git push`).
 */
export function createPilotScmPort(
  secrets: SecretPort,
  adoBaseUrl: string,
  github?: GithubEnv,
  githubFetch?: GithubFetchLike,
): ScmPort {
  if (github) return createPilotGithubScmPort(secrets, github, githubFetch);
  return createPilotFakeScmPort(secrets, adoBaseUrl);
}

/** The fake ADO ScmPort — unchanged: push disabled, `issueSecret` throws. */
export function createPilotFakeScmPort(secrets: SecretPort, adoBaseUrl: string): AdoScmDriver {
  return createAdoScmDriver(adoConfig(adoBaseUrl), {
    resolveToken: (ref) => secrets.get(ref),
    issueSecret: () => {
      throw new Error("pilot: bu akışta push yok, kısa ömürlü kimlik bilgisi üretilmiyor");
    },
  });
}

/**
 * The REAL GitHub ScmPort. The push credential is minted by an `issueSecret`
 * callback that reads the seeded GitHub token through the SecretPort and stamps
 * a short-lived `expiresAt` of now + the requested TTL. That expiry is a
 * POLICY commitment, enforced by the driver's `getPushCredential`
 * (`assertTtlWithinCeiling` + `issuedCredentialIssues`): the value is refused
 * if it is asked to outlive the one-hour ceiling, and the runner is expected to
 * push within the window. The token itself is NEVER logged or returned anywhere
 * but the credential, and never touches git config (see workspace.gitClone /
 * gitCommitPush).
 *
 * For the C4 go-live a GitHub App installation token (which genuinely expires)
 * can replace the PAT with no change here — the callback shape is identical.
 */
export function createPilotGithubScmPort(
  secrets: SecretPort,
  github: GithubEnv,
  fetchImpl?: GithubFetchLike,
): ScmPort {
  return createGithubScmDriver(
    {
      mode: "cloud",
      apiBaseUrl: github.apiBaseUrl,
      graphqlUrl: github.graphqlUrl,
      tokenRef: SECRET_REFS.github,
      maxPushTtlSeconds: GITHUB_PUSH_TTL_SECONDS,
    },
    {
      resolveToken: (ref) => secrets.get(ref),
      issueSecret: async (_scope, ttlSeconds) => {
        const secret = await secrets.get(SECRET_REFS.github);
        const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
        return { secret, expiresAt };
      },
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    },
  );
}

export function createPilotCiPort(secrets: SecretPort, adoBaseUrl: string): AdoCiDriver {
  return createAdoCiDriver(adoConfig(adoBaseUrl), {
    resolveToken: (ref) => secrets.get(ref),
    issueSecret: () => {
      throw new Error("pilot: CI sürücüsü kimlik bilgisi üretmez");
    },
  });
}

/** Hash-chained audit trail, in memory for the pilot (M33). */
export function createPilotAudit(): AuditChain {
  return new AuditChain({ store: new InMemoryAuditStore() });
}

export { resolveGithub, resolveJiraCloud, resolveOpenRouter };
