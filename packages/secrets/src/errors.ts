/**
 * Typed failures of the SecretPort drivers (M80).
 *
 * LEAK RULE — every class in this file is allowed to name *what* was asked for
 * (key, scope, mount, HTTP status) and never *what came back*. Unlike the Jira
 * driver we deliberately do NOT keep a response-body snippet: a Vault body is
 * secret material by definition, so it must not reach a log line, an error
 * message, `toString()` or `JSON.stringify()`. See test/leak.test.ts.
 */

/** Base class so callers can catch every secret failure in one branch. */
export class SecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretError";
  }
}

/** Driver configuration or wiring is wrong — thrown at construction time. */
export class SecretConfigError extends SecretError {
  constructor(reason: string) {
    super(`secrets driver configuration error: ${reason}`);
    this.name = "SecretConfigError";
  }
}

/** A caller handed the driver a key/scope the grammar rejects (§ keys.ts). */
export class SecretKeyError extends SecretError {
  constructor(
    readonly key: string,
    reason: string,
  ) {
    super(`invalid secret key "${key}": ${reason}`);
    this.name = "SecretKeyError";
  }
}

/** The path exists nowhere, or the requested field is absent (Vault 404). */
export class SecretNotFoundError extends SecretError {
  constructor(
    readonly key: string,
    readonly driver: string,
  ) {
    super(`secret "${key}" not found (driver: ${driver})`);
    this.name = "SecretNotFoundError";
  }
}

/**
 * The caller is authenticated but not entitled to this path: Vault 403, or the
 * key's mount is outside the configured allow-list (least privilege, M6).
 */
export class SecretPermissionDeniedError extends SecretError {
  constructor(
    readonly key: string,
    readonly driver: string,
    readonly reason: "vault_denied" | "mount_not_allowed" | "token_invalid",
  ) {
    super(`secret "${key}" denied (driver: ${driver}, reason: ${reason})`);
    this.name = "SecretPermissionDeniedError";
  }
}

/** Vault is sealed or standby (503/501) — retryable, distinct from denial. */
export class VaultSealedError extends SecretError {
  constructor(
    readonly status: number,
    readonly operation: string,
  ) {
    super(`vault is sealed or unavailable during ${operation} (HTTP ${status})`);
    this.name = "VaultSealedError";
  }
}

/** Any other non-2xx from Vault. Status only — never the body. */
export class VaultHttpError extends SecretError {
  constructor(
    readonly status: number,
    readonly operation: string,
  ) {
    super(`vault ${operation} failed with HTTP ${status}`);
    this.name = "VaultHttpError";
  }
}

/** Vault answered 2xx but without the fields the driver requires. */
export class VaultResponseError extends SecretError {
  constructor(
    readonly operation: string,
    readonly issue: string,
  ) {
    super(`vault ${operation} response is not usable: ${issue}`);
    this.name = "VaultResponseError";
  }
}

/** Requested TTL is missing, non-positive, or above the configured ceiling (M31). */
export class SecretTtlError extends SecretError {
  constructor(
    readonly requestedTtlSeconds: number,
    readonly maxTtlSeconds: number,
    reason: string,
  ) {
    super(`short-lived credential TTL ${requestedTtlSeconds}s rejected (max ${maxTtlSeconds}s): ${reason}`);
    this.name = "SecretTtlError";
  }
}

/**
 * A credential was issued but is already (or instantly) expired. Fail-closed:
 * an expired secret is never handed to the caller, it is thrown away.
 */
export class SecretExpiredError extends SecretError {
  constructor(
    readonly scope: string,
    readonly expiresAt: string,
  ) {
    super(`short-lived credential for scope "${scope}" expired at ${expiresAt} — refusing to return it`);
    this.name = "SecretExpiredError";
  }
}
