import type { CiPort, PortRegistry, ScmPort } from "@maestro/ports";
import { AdoCiDriver } from "./ci.js";
import { AdoClient, type FetchLike } from "./client.js";
import { type AdoConfig, parseAdoConfig } from "./config.js";
import type { SecretIssuer } from "./credential.js";
import { AdoScmDriver } from "./scm.js";

/** Driver id under both the "scm" and the "ci" port. */
export const ADO_DRIVER_ID = "ado";

/**
 * Everything the ADO drivers cannot construct themselves. Both secret
 * functions are callbacks on purpose: this package must not import the
 * secrets package, so the composition root binds SecretPort here (M44/M80).
 */
export interface AdoDriverDeps {
  /**
   * Resolves a secret ref to its value — typically SecretPort.get. Used for
   * `config.tokenRef` (the PAT) and `config.ci.webhookSecretRef` (the
   * Service Hook shared secret); the adapter holds neither value itself.
   */
  resolveToken: (tokenRef: string) => string | Promise<string>;
  /** Mints the short-lived push credential — SecretPort.issueShortLived. */
  issueSecret: SecretIssuer;
  /** Injectable fetch; defaults to the global one. */
  fetch?: FetchLike;
}

/** Builds the client for an already-validated config. */
export function createAdoClient(config: AdoConfig, deps: AdoDriverDeps): AdoClient {
  return new AdoClient({
    config,
    token: () => deps.resolveToken(config.tokenRef),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
}

export function createAdoScmDriver(config: unknown, deps: AdoDriverDeps): AdoScmDriver {
  const parsed = parseAdoConfig(config);
  return new AdoScmDriver({
    client: createAdoClient(parsed, deps),
    issueSecret: deps.issueSecret,
    maxPushTtlSeconds: parsed.maxPushTtlSeconds,
  });
}

/**
 * The CI driver needs no HTTP client (it only parses webhooks), but it does
 * need the Service Hook shared secret: the driver refuses to parse a body it
 * has not authenticated, so a driver built without a secret would be a
 * webhook endpoint with no door. The config is validated here — a typo, an
 * empty PR-validation allow-list or a missing `webhookSecretRef` must fail
 * at registration time, not at the first webhook.
 */
export function createAdoCiDriver(config: unknown, deps: AdoDriverDeps): AdoCiDriver {
  const parsed = parseAdoConfig(config);
  return new AdoCiDriver({
    ci: parsed.ci,
    resolveWebhookSecret: () => deps.resolveToken(parsed.ci.webhookSecretRef),
  });
}

/** Registers "scm"/"ado" and "ci"/"ado" in the port registry (M44). */
export function registerAdoDrivers(registry: PortRegistry, deps: AdoDriverDeps): void {
  registry.register<ScmPort>("scm", ADO_DRIVER_ID, (config) => createAdoScmDriver(config, deps));
  registry.register<CiPort>("ci", ADO_DRIVER_ID, (config) => createAdoCiDriver(config, deps));
}
