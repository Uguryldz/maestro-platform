import type { SecretPort } from "@maestro/ports";
import type { TokenRef } from "./config.js";
import { TokenResolutionError } from "./errors.js";

/**
 * Resolves the shared secret from a REFERENCE (task #1).
 *
 * The config never holds the secret itself, so this is the only place the
 * value exists, and it exists as a return value rather than as a field on a
 * long-lived object. Callers are given the resolver, not the result.
 *
 * The token is deliberately NOT cached forever: `secret-port` rotation is the
 * point of `SecretPort`, and a cache with no expiry turns a rotated credential
 * into an agent that authenticates until it restarts.
 */

export type TokenResolver = () => Promise<string>;

export interface TokenResolverOptions {
  ref: TokenRef;
  env?: Record<string, string | undefined>;
  /** Required when `ref.source` is `secret-port`. */
  secrets?: SecretPort;
  /** How long a resolved value may be reused. */
  cacheTtlMs?: number;
  now?: () => number;
}

const DEFAULT_CACHE_TTL_MS = 60_000;

/** Shortest credential worth calling a shared secret; `AgentToken` demands 24. */
const MIN_TOKEN_LENGTH = 24;

export function createTokenResolver(options: TokenResolverOptions): TokenResolver {
  const now = options.now ?? Date.now;
  const ttl = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  let cached: { value: string; expiresAt: number } | undefined;

  const fetchToken = async (): Promise<string> => {
    if (options.ref.source === "env") {
      const env = options.env ?? process.env;
      const value = env[options.ref.key];
      if (value === undefined || value.trim().length === 0) {
        // Names the VARIABLE, never a value — this message reaches logs.
        throw new TokenResolutionError(`environment variable "${options.ref.key}" is empty or unset`);
      }
      return value.trim();
    }
    if (options.secrets === undefined) {
      throw new TokenResolutionError("tokenRef.source is 'secret-port' but no SecretPort was provided");
    }
    let value: string;
    try {
      value = await options.secrets.get(options.ref.key);
    } catch (error) {
      throw new TokenResolutionError(
        `SecretPort could not resolve "${options.ref.key}": ${error instanceof Error ? error.name : "unknown error"}`,
      );
    }
    if (value.trim().length === 0) {
      throw new TokenResolutionError(`SecretPort returned an empty value for "${options.ref.key}"`);
    }
    return value.trim();
  };

  return async () => {
    const current = now();
    if (cached !== undefined && cached.expiresAt > current) return cached.value;
    const value = await fetchToken();
    if (value.length < MIN_TOKEN_LENGTH) {
      // Fail-closed: a short token is a misconfiguration, and registering with
      // it would only fail at the platform anyway — after it was on the wire.
      throw new TokenResolutionError(`resolved token is shorter than ${MIN_TOKEN_LENGTH} characters`);
    }
    cached = { value, expiresAt: current + ttl };
    return value;
  };
}
