import { CapabilityNotSupportedError, type SecretPort } from "@maestro/ports";
import { type Clock, systemClock, TtlCache } from "./cache.js";
import { VAULT_DRIVER, type VaultConfig } from "./config.js";
import {
  SecretConfigError,
  SecretExpiredError,
  SecretNotFoundError,
  SecretPermissionDeniedError,
  SecretTtlError,
  VaultResponseError,
} from "./errors.js";
import { parseScope } from "./keys.js";
import { resolveKey, toIsoDateTime } from "./shared.js";
import type { VaultBody, VaultClient, VaultReadResult } from "./vault-client.js";

/**
 * How much longer than the requested window a granted lease may run before the
 * driver calls it a violation. Mirrors `EXPIRY_SKEW_SECONDS` in adapter-ado,
 * which rejects exactly the same condition on the consuming side — the two
 * packages must not disagree about what "short-lived" means (M31).
 */
const GRANTED_LEASE_SKEW_SECONDS = 60;

export interface VaultSecretPortOptions {
  config: VaultConfig;
  client: VaultClient;
  clock?: Clock;
}

/**
 * SecretPort over HashiCorp Vault KV v2 (M80) plus dynamic short-lived
 * credentials (M31/M6). Fail-closed throughout: an absent, empty or expired
 * secret is an error, never a silent fallback.
 */
export class VaultSecretPort implements SecretPort {
  readonly driver = VAULT_DRIVER;
  readonly config: VaultConfig;
  readonly #client: VaultClient;
  readonly #cache: TtlCache<string>;
  readonly #clock: Clock;

  constructor(options: VaultSecretPortOptions) {
    const { config } = options;
    if (!config.allowedMounts.includes(config.shortLived.mount)) {
      throw new SecretConfigError(
        `shortLived.mount "${config.shortLived.mount}" is not in allowedMounts — issuance would always be denied`,
      );
    }
    this.config = config;
    this.#client = options.client;
    this.#clock = options.clock ?? systemClock;
    this.#cache = new TtlCache<string>(config.cacheTtlSeconds, this.#clock);
  }

  async get(key: string): Promise<string> {
    const parsed = resolveKey(key, this.config.allowedMounts, VAULT_DRIVER);

    const cached = this.#cache.get(key);
    if (cached !== undefined) return cached;

    const where = `${parsed.mount}/${parsed.path}`;
    const result = await this.#client.read(`${parsed.mount}/data/${parsed.path}`, `read ${where}`);
    const body = unwrap(result, key);

    const value = readKvField(body.data, parsed.field);
    if (value === undefined) throw new SecretNotFoundError(key, VAULT_DRIVER);

    this.#cache.set(key, value);
    return value;
  }

  /**
   * Issue a scoped credential from a dynamic secrets engine. The TTL is
   * mandatory and capped by `shortLived.maxTtlSeconds`; an oversized request is
   * REJECTED rather than clamped, so a caller can never believe it holds a
   * longer-lived credential than Vault actually granted.
   *
   * The ceiling binds the GRANTED lease as well as the request (M31): a Vault
   * role whose own ttl is 24h must not be able to hand a day-long push token
   * back through a driver that promises short-lived credentials. And when the
   * response carries no usable `lease_duration`, the driver refuses instead of
   * assuming it got what it asked for — a guessed expiry is a credential that
   * outlives its window without anyone noticing.
   */
  async issueShortLived(scope: string, ttlSeconds: number): Promise<{ secret: string; expiresAt: string }> {
    const parsedScope = parseScope(scope);
    const { mount, pathPrefix, field, maxTtlSeconds } = this.config.shortLived;

    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new SecretTtlError(ttlSeconds, maxTtlSeconds, "ttl must be a positive whole number of seconds");
    }
    if (ttlSeconds > maxTtlSeconds) {
      throw new SecretTtlError(ttlSeconds, maxTtlSeconds, "above the configured ceiling (M31)");
    }

    const operation = `issue ${mount}/${pathPrefix}/${parsedScope}`;
    const result = await this.#client.read(`${mount}/${pathPrefix}/${parsedScope}`, operation, {
      ttl: `${ttlSeconds}s`,
    });
    const body = unwrap(result, `${mount}/${pathPrefix}/${parsedScope}`);

    const secret = readField(body.data, field);
    if (secret === undefined) throw new VaultResponseError(operation, `field "${field}" is missing or empty`);

    // Bounds are checked BEFORE any date arithmetic: `lease_duration: 1e18`
    // otherwise escapes as an untyped RangeError from the Date constructor.
    const granted = body.lease_duration;
    if (typeof granted !== "number" || !Number.isSafeInteger(granted)) {
      throw new VaultResponseError(operation, "lease_duration is missing or not a whole number of seconds");
    }
    if (granted <= 0) throw new SecretExpiredError(parsedScope, toIsoDateTime(this.#clock()));
    if (granted > maxTtlSeconds) {
      throw new SecretTtlError(ttlSeconds, maxTtlSeconds, `vault granted ${granted}s, above the ceiling (M31)`);
    }
    if (granted > ttlSeconds + GRANTED_LEASE_SKEW_SECONDS) {
      throw new SecretTtlError(ttlSeconds, maxTtlSeconds, `vault granted ${granted}s, outliving the requested window`);
    }

    // Never cached: a short-lived credential is single-use by design.
    return { secret, expiresAt: toIsoDateTime(this.#clock() + granted * 1000) };
  }

  /**
   * The connector UI's WRITE path is deliberately not this driver's job. The
   * Vault mount holds deployment-provisioned secrets an operator manages in
   * Vault itself; letting a Studio console rewrite a KV path would sit below the
   * mount allow-list this driver enforces and hand out a way around least
   * privilege (M6/M80). A console-written connector token is stored by the
   * DB-backed `EncryptedSecretStore` instead, which is the only SecretPort whose
   * `set` actually writes. So this one refuses, loudly, rather than pretend.
   */
  set(_key: string, _value: string): Promise<void> {
    return Promise.reject(new CapabilityNotSupportedError("SecretPort", "set"));
  }

  /** Drops cached values, e.g. after a rotation signal. */
  invalidate(): void {
    this.#cache.clear();
  }

  toJSON(): { driver: string; addr: string; allowedMounts: string[]; cacheTtlSeconds: number } {
    return {
      driver: this.driver,
      addr: this.config.addr,
      allowedMounts: [...this.config.allowedMounts],
      cacheTtlSeconds: this.config.cacheTtlSeconds,
    };
  }

  toString(): string {
    return `VaultSecretPort(${this.config.addr})`;
  }

}

/** 403 → denied, 404 → not found; both named after the key the caller asked for. */
function unwrap(result: VaultReadResult, key: string): VaultBody {
  if (result.ok) return result.body;
  if (result.kind === "denied") throw new SecretPermissionDeniedError(key, VAULT_DRIVER, "vault_denied");
  throw new SecretNotFoundError(key, VAULT_DRIVER);
}

/** KV v2 nests the secret object one level deeper: `{ data: { data: {...} } }`. */
function readKvField(payload: unknown, field: string): string | undefined {
  const inner = (payload as { data?: unknown } | null | undefined)?.data;
  return readField(inner, field);
}

/** An empty value is treated as absent — M6 forbids booting on a placeholder. */
function readField(payload: unknown, field: string): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
