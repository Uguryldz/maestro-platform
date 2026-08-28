import { createAdoCiDriver, createAdoScmDriver, type AdoCiDriver, type AdoScmDriver } from "@maestro/adapter-ado";
import { createJiraDcWorkPort, type JiraDcWorkPort } from "@maestro/adapter-jira";
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
  DEMO_MODEL,
  DEMO_SECRETS,
  SECRET_REFS,
} from "./config.js";
import { resolveOpenRouter, type OpenRouterEnv } from "./env.js";

/**
 * Composition root of the demo. Every port below is the REAL package driver;
 * only the servers they talk to are props. Nothing here holds a secret value:
 * the drivers resolve references through the SecretPort, exactly as the
 * composition root of the real BFF would (M44/M80).
 */

/**
 * Environment-variable name for a secret reference, using the driver's own
 * mapping rather than a re-implementation of it — the two must not drift.
 */
function envName(reference: string): string {
  return envVarName(parseSecretKey(reference), "MAESTRO_SECRET_");
}

/**
 * SecretPort for the demo: the real `env-file` driver, fed from an in-memory
 * record rather than `process.env`, so the OpenRouter key never lands in the
 * environment of any child process the demo spawns.
 */
export function createDemoSecrets(openRouter: OpenRouterEnv): SecretPort {
  const env: Record<string, string> = {
    [envName(SECRET_REFS.jiraPat)]: DEMO_SECRETS.jiraPat,
    [envName(SECRET_REFS.jiraWebhook)]: DEMO_SECRETS.jiraWebhook,
    [envName(SECRET_REFS.adoPat)]: DEMO_SECRETS.adoPat,
    [envName(SECRET_REFS.adoWebhook)]: DEMO_SECRETS.adoWebhook,
    [envName(SECRET_REFS.openrouter)]: openRouter.apiKey,
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
 * The LLM gateway over OpenRouter's OpenAI-compatible API.
 *
 * `onPremMissing: "masked_cloud"` with a `gizli` data class is the honest
 * configuration for this demo: there is no on-prem model, so the gateway
 * masks the payload through `@maestro/pii` before anything leaves the machine
 * and re-scans the result before it is sent (M18/M20).
 */
export function createDemoGateway(
  secrets: SecretPort,
  openRouter: OpenRouterEnv,
  hooks: GatewayHooks = {},
): { gateway: LlmGateway; policy: LoadedPiiPolicy } {
  const policy = defaultPiiPolicy();
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
        { role: "intake", driver: "openai-compat", model: DEMO_MODEL },
        { role: "analyst", driver: "openai-compat", model: DEMO_MODEL },
        { role: "engineer", driver: "openai-compat", model: DEMO_MODEL },
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

/** Jira DC WorkPort driver aimed at the fake instance. */
export function createDemoWorkPort(secrets: SecretPort, jiraBaseUrl: string): JiraDcWorkPort {
  return createJiraDcWorkPort({
    baseUrl: jiraBaseUrl,
    tokenRef: SECRET_REFS.jiraPat,
    webhookSecretRef: SECRET_REFS.jiraWebhook,
    requestTimeoutMs: 15_000,
    deps: { secrets },
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

export function createDemoScmPort(secrets: SecretPort, adoBaseUrl: string): AdoScmDriver {
  return createAdoScmDriver(adoConfig(adoBaseUrl), {
    resolveToken: (ref) => secrets.get(ref),
    // The demo never pushes, so no credential is ever minted; the issuer exists
    // only to satisfy the driver's constructor and refuses if it is called.
    issueSecret: () => {
      throw new Error("demo: bu akışta push yok, kısa ömürlü kimlik bilgisi üretilmiyor");
    },
  });
}

export function createDemoCiPort(secrets: SecretPort, adoBaseUrl: string): AdoCiDriver {
  return createAdoCiDriver(adoConfig(adoBaseUrl), {
    resolveToken: (ref) => secrets.get(ref),
    issueSecret: () => {
      throw new Error("demo: CI sürücüsü kimlik bilgisi üretmez");
    },
  });
}

/** Hash-chained audit trail, in memory for the demo (M33). */
export function createDemoAudit(): AuditChain {
  return new AuditChain({ store: new InMemoryAuditStore() });
}

export { resolveOpenRouter };
