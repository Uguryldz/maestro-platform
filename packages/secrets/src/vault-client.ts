import { type Clock, systemClock } from "./cache.js";
import { type VaultConfig, vaultAddrIssue } from "./config.js";
import {
  SecretConfigError,
  SecretPermissionDeniedError,
  VaultHttpError,
  VaultResponseError,
  VaultSealedError,
} from "./errors.js";

/** Narrow `fetch` shape the client depends on — keeps tests fully offline. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** AppRole material. Runtime deps, never declarative config (M44). */
export interface AppRoleCredentials {
  roleId: string;
  secretId: string;
}

export interface VaultClientOptions {
  config: VaultConfig;
  approle: AppRoleCredentials;
  fetchImpl?: FetchLike;
  clock?: Clock;
}

/** 2xx body of a Vault read; `data` is secret material and stays internal. */
export interface VaultBody {
  data?: unknown;
  lease_duration?: number;
}

/**
 * Outcome of a read. 403/404 are DATA, not exceptions, so the caller can name
 * the secret key in the error it raises; sealed/other statuses throw here
 * because no key-level distinction exists for them.
 */
export type VaultReadResult = { ok: true; body: VaultBody } | { ok: false; kind: "denied" | "not_found" };

/**
 * Minimal HashiCorp Vault client: AppRole login, lease-aware client token with
 * renewal before expiry, and raw reads. Deliberately small — Vault's HTTP API
 * surface we need is three endpoints.
 *
 * Leak rule: role_id/secret_id and the client token live in `#private` fields,
 * so they are invisible to `JSON.stringify`, `Object.keys` and `toString`.
 */
export class VaultClient {
  readonly #roleId: string;
  readonly #secretId: string;
  #token: string | null = null;
  #tokenExpiresAtMs = 0;
  /** When re-authentication starts — always strictly inside the lease. */
  #renewAtMs = 0;
  #renewable = false;
  /** Single-flight guard: concurrent reads must not trigger parallel logins. */
  #pendingAuth: Promise<string> | null = null;

  readonly config: VaultConfig;
  readonly #fetchImpl: FetchLike;
  readonly #clock: Clock;

  constructor(options: VaultClientOptions) {
    const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
    if (!fetchImpl) throw new SecretConfigError("no fetch implementation available");
    if (options.approle.roleId.trim().length === 0 || options.approle.secretId.trim().length === 0) {
      throw new SecretConfigError("approle roleId/secretId are required (M6: no default credentials)");
    }
    const addrIssue = vaultAddrIssue(options.config);
    if (addrIssue) throw new SecretConfigError(addrIssue);
    this.config = options.config;
    this.#roleId = options.approle.roleId;
    this.#secretId = options.approle.secretId;
    this.#fetchImpl = fetchImpl;
    this.#clock = options.clock ?? systemClock;
  }

  /** Valid client token, logging in or renewing as needed. */
  async token(): Promise<string> {
    if (this.#token !== null && this.#clock() < this.#renewAtMs) return this.#token;
    this.#pendingAuth ??= this.#authenticate().finally(() => {
      this.#pendingAuth = null;
    });
    return this.#pendingAuth;
  }

  async read(vaultPath: string, operation: string, query?: Record<string, string>): Promise<VaultReadResult> {
    const url = new URL(`${this.#base()}/v1/${vaultPath}`);
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);

    const res = await this.#send(url.toString(), { method: "GET" }, await this.token());
    if (res.ok) return { ok: true, body: await this.#json(res, operation) };
    if (res.status === 403) return { ok: false, kind: "denied" };
    if (res.status === 404) return { ok: false, kind: "not_found" };
    throw statusError(res.status, operation);
  }

  /** Test/ops visibility into the lease without exposing the token itself. */
  tokenExpiresAtMs(): number {
    return this.#token === null ? 0 : this.#tokenExpiresAtMs;
  }

  toJSON(): { addr: string; authenticated: boolean; tokenExpiresAtMs: number } {
    return { addr: this.config.addr, authenticated: this.#token !== null, tokenExpiresAtMs: this.tokenExpiresAtMs() };
  }

  toString(): string {
    return `VaultClient(${this.config.addr}, authenticated=${this.#token !== null})`;
  }

  async #authenticate(): Promise<string> {
    if (this.#token !== null && this.#renewable) {
      const renewed = await this.#renewSelf();
      if (renewed !== null) return renewed;
    }
    return this.#login();
  }

  async #login(): Promise<string> {
    const url = `${this.#base()}/v1/auth/${this.config.approleMount}/login`;
    const res = await this.#send(
      url,
      { method: "POST", body: JSON.stringify({ role_id: this.#roleId, secret_id: this.#secretId }) },
      null,
    );
    if (!res.ok) {
      if (res.status === 400 || res.status === 403) {
        throw new SecretPermissionDeniedError(`auth/${this.config.approleMount}`, "vault", "token_invalid");
      }
      throw statusError(res.status, "approle login");
    }
    return this.#adoptAuth(await this.#json(res, "approle login"), "approle login", false);
  }

  /** Returns null when renewal is not possible, so the caller falls back to login. */
  async #renewSelf(): Promise<string | null> {
    try {
      const res = await this.#send(`${this.#base()}/v1/auth/token/renew-self`, { method: "POST" }, this.#token);
      if (!res.ok) return null;
      // A renewal EXTENDS the token we already hold, so its body need not repeat it.
      return this.#adoptAuth(await this.#json(res, "token renew"), "token renew", true);
    } catch {
      // Renewal is best effort; a fresh login is always the safe fallback.
      return null;
    }
  }

  /**
   * Adopts an auth block.
   *
   * `keepCurrentToken` is true only on the renewal path. A LOGIN that answers
   * without a `client_token` means this process has no identity at all; reusing
   * the previous one there would put a token Vault has just revoked back on the
   * wire under a fresh deadline, and every later 403 would be reported as a
   * policy denial instead of the identity failure it really is.
   */
  #adoptAuth(body: unknown, operation: string, keepCurrentToken: boolean): string {
    const auth = (body as { auth?: { client_token?: unknown; lease_duration?: unknown; renewable?: unknown } })?.auth;
    const issued = typeof auth?.client_token === "string" && auth.client_token.length > 0 ? auth.client_token : null;
    const clientToken = issued ?? (keepCurrentToken ? this.#token : null);
    if (!clientToken) throw new VaultResponseError(operation, "no client token in auth block");

    const lease = auth?.lease_duration;
    if (typeof lease !== "number" || !Number.isSafeInteger(lease) || lease <= 0) {
      throw new VaultResponseError(operation, "lease_duration missing, non-positive or not a whole number of seconds");
    }

    this.#token = clientToken;
    this.#renewable = auth?.renewable === true;
    this.#tokenExpiresAtMs = this.#clock() + lease * 1000;
    // Renew inside the lease, never before it starts: with a lease shorter than
    // twice the configured skew a fixed skew would re-authenticate on EVERY
    // read (30s lease, 60s skew → one login per call).
    this.#renewAtMs = this.#tokenExpiresAtMs - Math.min(this.config.tokenRenewSkewSeconds * 1000, (lease * 1000) / 2);
    return clientToken;
  }

  #base(): string {
    return this.config.addr.replace(/\/+$/, "");
  }

  async #send(url: string, init: RequestInit, token: string | null): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (token !== null) headers["x-vault-token"] = token;
    if (this.config.namespace) headers["x-vault-namespace"] = this.config.namespace;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    return this.#fetchImpl(url, {
      ...init,
      headers,
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
  }

  /** Parses a 2xx body. The body is never echoed into an error (leak rule). */
  async #json(res: Response, operation: string): Promise<VaultBody> {
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new VaultResponseError(operation, "response body could not be read");
    }
    if (text.trim().length === 0) throw new VaultResponseError(operation, "empty response body");
    try {
      return JSON.parse(text) as VaultBody;
    } catch {
      throw new VaultResponseError(operation, "response body is not JSON");
    }
  }
}

/** 501 standby / 503 sealed are their own failure class (retryable). */
function statusError(status: number, operation: string): Error {
  if (status === 501 || status === 503) return new VaultSealedError(status, operation);
  return new VaultHttpError(status, operation);
}
