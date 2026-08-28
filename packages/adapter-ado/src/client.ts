import { apiRoot, apiVersionFor, type AdoConfig } from "./config.js";
import { AdoAuthError, AdoHttpError, AdoNotFoundError } from "./errors.js";

/** Injected fetch so tests run offline; defaults to the global fetch (Node 24). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Supplies the Personal Access Token for `config.tokenRef`. Injected as a
 * callback: this package must never depend on the secrets package (M80) —
 * the composition root wires SecretPort.get(tokenRef) in here.
 */
export type TokenProvider = () => string | Promise<string>;

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface AdoRequest {
  /** ADO project name; the client places it in the mode-specific URL. */
  project: string;
  /** Path below `_apis`, e.g. "git/repositories/ugurpay/pullrequests". */
  path: string;
  method?: HttpMethod;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Per-call api-version override; defaults to the mode-pinned version. */
  apiVersion?: string;
}

export interface AdoClientOptions {
  config: AdoConfig;
  token: TokenProvider;
  fetch?: FetchLike;
}

const BODY_SNIPPET_MAX = 500;

/**
 * Thin REST client for Azure DevOps. It owns exactly three concerns:
 * dual-mode URL building, PAT basic auth, and turning transport failures
 * into typed errors. Response shapes are validated by the callers with Zod.
 */
export class AdoClient {
  private readonly config: AdoConfig;
  private readonly token: TokenProvider;
  private readonly doFetch: FetchLike;

  constructor(options: AdoClientOptions) {
    this.config = options.config;
    this.token = options.token;
    this.doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  get mode(): AdoConfig["mode"] {
    return this.config.mode;
  }

  /** Fully-qualified URL for a request, including the pinned api-version. */
  buildUrl(request: AdoRequest): string {
    const root = apiRoot(this.config, request.project);
    const path = request.path.replace(/^\/+/, "");
    const url = new URL(`${root}/${path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    url.searchParams.set("api-version", request.apiVersion ?? apiVersionFor(this.config));
    return url.toString();
  }

  /**
   * Performs the request and returns the parsed JSON body (null for 204).
   * Throws AdoAuthError / AdoNotFoundError / AdoHttpError on non-2xx.
   */
  async request(request: AdoRequest): Promise<unknown> {
    const method = request.method ?? "GET";
    const url = this.buildUrl(request);
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: await this.authorizationHeader(),
    };
    if (request.body !== undefined) headers["content-type"] = "application/json";

    const response = await this.doFetch(url, {
      method,
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    });

    if (!response.ok) {
      const snippet = truncate(await safeText(response), BODY_SNIPPET_MAX);
      throw httpError(response.status, method, url, snippet);
    }
    // ADO answers an unauthenticated API call with "203 Non-Authoritative
    // Information" plus a sign-in HTML page instead of a 401. `response.ok`
    // is true for 203, so it has to be caught here or the JSON parse below
    // would fail with a misleading error.
    if (response.status === 203) {
      throw new AdoAuthError(203, method, url, "sign-in page returned instead of API response");
    }
    if (response.status === 204) return null;

    const text = await safeText(response);
    if (text.trim() === "") return null;
    return JSON.parse(text) as unknown;
  }

  private async authorizationHeader(): Promise<string> {
    const pat = await this.token();
    // ADO PAT auth is HTTP basic with an empty username.
    return `Basic ${Buffer.from(`:${pat}`, "utf8").toString("base64")}`;
  }
}

function httpError(status: number, method: string, url: string, snippet: string): AdoHttpError {
  if (status === 401 || status === 403) return new AdoAuthError(status, method, url, snippet);
  if (status === 404) return new AdoNotFoundError(status, method, url, snippet);
  return new AdoHttpError(status, method, url, snippet);
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
