import type { PortRegistry, ScmPort } from "@maestro/ports";
import { GithubClient, type FetchLike } from "./client.js";
import { type GithubConfig, parseGithubConfig } from "./config.js";
import type { SecretIssuer } from "./credential.js";
import { GithubScmDriver } from "./scm.js";

/** Driver id under the "scm" port. */
export const GITHUB_DRIVER_ID = "github";

/**
 * Everything the GitHub driver cannot construct itself. Both secret functions
 * are callbacks on purpose: this package must not import the secrets package,
 * so the composition root binds SecretPort here (M44/M80).
 */
export interface GithubDriverDeps {
  /** Resolves a secret ref to its value — typically SecretPort.get. Used for `config.tokenRef`. */
  resolveToken: (tokenRef: string) => string | Promise<string>;
  /** Mints the short-lived push credential — SecretPort.issueShortLived. */
  issueSecret: SecretIssuer;
  /** Injectable fetch; defaults to the global one. */
  fetch?: FetchLike;
}

/** Builds the client for an already-validated config. */
export function createGithubClient(config: GithubConfig, deps: GithubDriverDeps): GithubClient {
  return new GithubClient({
    config,
    token: () => deps.resolveToken(config.tokenRef),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
}

export function createGithubScmDriver(config: unknown, deps: GithubDriverDeps): GithubScmDriver {
  const parsed = parseGithubConfig(config);
  return new GithubScmDriver({
    client: createGithubClient(parsed, deps),
    issueSecret: deps.issueSecret,
    maxPushTtlSeconds: parsed.maxPushTtlSeconds,
  });
}

/** Registers "scm"/"github" in the port registry (M44). */
export function registerGithubDrivers(registry: PortRegistry, deps: GithubDriverDeps): void {
  registry.register<ScmPort>("scm", GITHUB_DRIVER_ID, (config) =>
    createGithubScmDriver(config, deps),
  );
}
