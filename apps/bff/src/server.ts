import { loadEnv } from "@maestro/config";
import { tlsAwareFetchWith } from "@maestro/llm-gateway";
import type { MaestroPlatform } from "@maestro/mcp-servers";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import { connectionTlsFlag } from "./connection-service.js";
import { commandDiagnosticsOf, type BffConfig, type BffDeps, type ResolvedDeps } from "./deps.js";
import { HttpError } from "./errors.js";
import { assertCatalog, defaultCatalog } from "./messages.js";
import { SESSION_TTL_MS } from "./auth/sessions.js";
import { bffPlatform } from "./platform/index.js";
import { authRoutes } from "./routes/auth.js";
import { connectionRoutes } from "./routes/connections.js";
import { listeningRoutes } from "./routes/listening.js";
import { guidanceRoutes } from "./routes/guidance.js";
import { docTemplateRoutes } from "./routes/doc-template.js";
import { healthRoutes } from "./routes/health.js";
import { settingsRoutes } from "./routes/settings.js";
import { jiraWorkflowRoutes } from "./routes/jira-workflow.js";
import { killSwitchRoutes } from "./routes/killswitch.js";
import { onboardingRoutes } from "./routes/onboarding.js";
import { paramRoutes } from "./routes/params.js";
import { repoPolicyRoutes } from "./routes/repo-policy.js";
import { runRoutes } from "./routes/runs.js";
import { studioCatalogRoutes } from "./routes/studio-catalog.js";
import { templateRoutes } from "./routes/template.js";
import { studioOpsRoutes } from "./routes/studio-ops.js";
import { studioRunRoutes } from "./routes/studio-runs.js";
import { studioEvalRoutes } from "./routes/studio-eval.js";
import { studioGovernanceRoutes } from "./routes/studio-governance.js";
import { studioSurfaceRoutes } from "./routes/studio-surface.js";
import { studioVariantRoutes } from "./routes/studio-variants.js";
import { webhookRoutes } from "./routes/webhooks.js";

export const DEFAULT_CONFIG: Omit<BffConfig, "env"> = {
  actorDomain: "corp",
  locale: "tr",
  sessionTtlMs: SESSION_TTL_MS,
  optInLabel: "maestro",
  // No default identity. An unset engine account means "nothing to compare
  // against", and the connector test skips its identity check entirely — the
  // alternative (guessing an id) would let the test accuse a correct connection.
  engineBotAccountId: "",
};

/**
 * Maximum request body, chosen rather than inherited (M15). Fastify defaults to
 * 1 MB, which a real Jira delivery can exceed: a ticket with a long Turkish
 * description, a pasted stack trace and a dozen comments is not unusual, and
 * losing those deliveries would look like an outage nobody configured. 8 MB is
 * comfortably above a plausible ticket and far below anything that threatens
 * the process — the raw body is held in memory to verify its signature.
 */
export const BODY_LIMIT_BYTES = 8 * 1024 * 1024;

export function resolveDeps(deps: BffDeps): ResolvedDeps {
  const { messages, clock, config, studio, connectorFetch, ...rest } = deps;
  // `loadEnv` throws in production when a connection value is missing (M6);
  // reading it here means the process cannot come up half-configured.
  const env = config?.env ?? loadEnv();
  return {
    ...rest,
    // `{}` rather than a set of stubs: every model inside stays optional, and a
    // route whose model is absent refuses by name instead of answering empty.
    studio: studio ?? {},
    messages: messages ?? defaultCatalog,
    clock: clock ?? { now: () => new Date() },
    // Precedence: an explicit config override wins, then the env variable, then
    // the built-in default.
    config: {
      env,
      ...DEFAULT_CONFIG,
      // The engine's own account, read straight off the validated env — the same
      // variable the runtime boots its discovery JQL from, so the two halves of
      // the deployment are compared against ONE source rather than two copies.
      ...(env.MAESTRO_BOT_ACCOUNT_ID !== undefined
        ? { engineBotAccountId: env.MAESTRO_BOT_ACCOUNT_ID }
        : {}),
      ...config,
    },
    // The connector transport (live tests, onboarding lists, listening seed).
    // Real fetch unless a test injects a stub; the URL is always built from a
    // stored `baseUrl`, never a request. The default is TLS-AWARE: it applies
    // the same skip rule as the probe and the runtime drivers — the internal-
    // address auto rule plus the per-connection `skipTlsVerify` switch, looked
    // up by host in the connection store on each call — so a Jira DC or ADO
    // behind a corporate certificate answers the onboarding screens exactly
    // the way its green connection test promised.
    connectorFetch: connectorFetch ?? tlsAwareFetchWith(connectionTlsFlag(deps.connections)),
    diagnostics: commandDiagnosticsOf(deps.work),
    counters: { droppedUnbound: 0, droppedKillSwitch: 0, invalidCommands: 0 },
  };
}

export interface BuildServerOptions {
  fastify?: FastifyServerOptions;
}

/**
 * The single data door (M7). Studio never touches the database; everything it
 * knows arrives through these routes, and every one of them authenticates —
 * the REST surface with a session token, the webhooks with the delivery
 * signature their port verifies.
 *
 * The catalog is checked before a socket is opened (M6/M104): a service that
 * cannot render the sentence it owes a user must not accept traffic, because
 * the failure would otherwise surface as a raw key inside a bank's Jira ticket.
 */
export async function buildServer(
  deps: BffDeps,
  options: BuildServerOptions = {},
): Promise<FastifyInstance> {
  const resolved = resolveDeps(deps);
  assertCatalog(resolved.messages, resolved.config.locale);

  // `options.fastify` may override the limit deliberately, but it is never
  // absent: an unset bodyLimit silently becomes Fastify's 1 MB.
  /**
   * Logging ON, at `warn`.
   *
   * It was `false`, and the error handler below dutifully called
   * `request.log.error` into a logger that discarded it — so a 500 reached the
   * operator as `{"error":"internal_error"}` with NOTHING on the server side
   * saying why. That is not a privacy property; the response body is already
   * opaque by design, and the whole point of the pair is that the reason lives
   * where only the operator can read it. Found by driving the real stack: a
   * wired read model threw, Studio showed an empty dashboard, and the log was
   * silent.
   *
   * `warn` rather than `info` keeps per-request noise out of a bank's log
   * aggregator while letting every refusal and unhandled error through. Tests
   * pass `options.fastify` and stay quiet.
   */
  const app = Fastify({
    logger: { level: process.env["LOG_LEVEL"] ?? "warn" },
    bodyLimit: BODY_LIMIT_BYTES,
    ...options.fastify,
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof HttpError) {
      const body: Record<string, unknown> = { error: error.code };
      if (error.details !== undefined) body["details"] = error.details;
      void reply.code(error.status).send(body);
      return;
    }
    if (typeof error.statusCode === "number" && error.statusCode < 500) {
      void reply.code(error.statusCode).send({ error: error.code ?? "bad_request" });
      return;
    }
    request.log.error({ err: error }, "unhandled error");
    void reply.code(500).send({ error: "internal_error" });
  });

  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send({ error: "not_found" });
  });

  await app.register(async (scope) => healthRoutes(scope, resolved));
  // Own encapsulation context: the raw-body parser must not reach the JSON API.
  await app.register(async (scope) => webhookRoutes(scope, resolved));
  await app.register(async (scope) => authRoutes(scope, resolved));
  await app.register(async (scope) => runRoutes(scope, resolved));
  await app.register(async (scope) => paramRoutes(scope, resolved));
  await app.register(async (scope) => templateRoutes(scope, resolved));
  // Own encapsulation context: the binary `.docx` parser it registers must not
  // reach the JSON API, where it would turn every other body into a Buffer.
  await app.register(async (scope) => docTemplateRoutes(scope, resolved));
  await app.register(async (scope) => settingsRoutes(scope, resolved));
  // The workflow-import surface (M102): a Jira project's live statuses and
  // transitions, read for Studio to map onto Maestro's steps. Admin/tech-lead,
  // read-only, and refuses by name (503) when no reader is wired — the same
  // convention as the read models, so an unwired import cannot render as "this
  // project has no workflow".
  await app.register(async (scope) => jiraWorkflowRoutes(scope, resolved));
  // The connector-management surface: the platform's outbound connections made
  // admin-editable, with tokens stored AES-encrypted and read back only as a
  // mask. Refuses by name (503) when the store + encrypting SecretPort are not
  // wired, the same convention as the read models above.
  await app.register(async (scope) => connectionRoutes(scope, resolved));
  // The listening-rules surface: which tickets Maestro picks up and how it runs
  // them (status/issuetype → flow type), made admin-editable. Refuses by name
  // (503) when no ListeningStore is wired, the same convention as above.
  await app.register(async (scope) => listeningRoutes(scope, resolved));
  await app.register(async (scope) => guidanceRoutes(scope, resolved));
  await app.register(async (scope) => killSwitchRoutes(scope, resolved));
  // Studio's read surface (M86/M7): the 37 screens read through these, and
  // through the same guards and the same project scoping as everything above.
  await app.register(async (scope) => studioRunRoutes(scope, resolved));
  await app.register(async (scope) => studioOpsRoutes(scope, resolved));
  await app.register(async (scope) => studioCatalogRoutes(scope, resolved));
  // The last eight screens: the variant catalogue, the two auditor surfaces,
  // and the product rules (commands, MCP manifest). The endpoints whose stores
  // do not exist are registered too — they answer 503 with a named reason,
  // which is the point: an unregistered route 404s, and a 404 renders as
  // "not built yet" rather than "this capability is not wired here".
  await app.register(async (scope) => studioVariantRoutes(scope, resolved));
  await app.register(async (scope) => studioEvalRoutes(scope, resolved));
  await app.register(async (scope) => studioGovernanceRoutes(scope, resolved));
  await app.register(async (scope) => studioSurfaceRoutes(scope, resolved));
  // Onboarding a project and reading a repo's `.maestro.yaml` (M93/M102/M52).
  // Both are admin/tech-lead surfaces, and the onboarding write files a
  // proposal rather than a binding — see `routes/onboarding.ts`.
  await app.register(async (scope) => onboardingRoutes(scope, resolved));
  await app.register(async (scope) => repoPolicyRoutes(scope, resolved));

  app.decorate("maestro", resolved);
  // The MCP surface reads the platform through the SAME container, so an AI and
  // a human asking the same question reach the same read models (M101).
  app.decorate("platform", bffPlatform(resolved));
  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    /** The resolved container, for tests and for the composition root. */
    maestro: ResolvedDeps;
    /** `MaestroPlatform` over this container — what maestro-mcp is injected with (M101). */
    platform: MaestroPlatform;
  }
}
