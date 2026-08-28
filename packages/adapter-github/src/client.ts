import { apiVersionFor, type GithubConfig } from "./config.js";
import {
  GithubAuthError,
  GithubHttpError,
  GithubNotFoundError,
  GithubRateLimitError,
  GithubResponseError,
  GithubValidationError,
} from "./errors.js";

/** Injected fetch so tests run offline; defaults to the global fetch (Node 24). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Supplies the Bearer token for `config.tokenRef`. Injected as a callback:
 * this package must never depend on the secrets package (M80) — the
 * composition root wires SecretPort.get(tokenRef) in here. Re-read on every
 * call so a rotated / freshly-minted installation token is picked up.
 */
export type TokenProvider = () => string | Promise<string>;

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface GithubRequest {
  /** Path below the REST root, e.g. "repos/ugurbank/ugurpay/pulls". */
  path: string;
  method?: HttpMethod;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export interface GithubClientOptions {
  config: GithubConfig;
  token: TokenProvider;
  fetch?: FetchLike;
}

const BODY_SNIPPET_MAX = 500;

/**
 * Thin REST + GraphQL client for GitHub. It owns exactly three concerns:
 * URL building, Bearer auth with the pinned api-version header, and turning
 * transport failures into typed errors. Response shapes are validated by the
 * callers with Zod.
 */
export class GithubClient {
  private readonly config: GithubConfig;
  private readonly token: TokenProvider;
  private readonly doFetch: FetchLike;

  constructor(options: GithubClientOptions) {
    this.config = options.config;
    this.token = options.token;
    this.doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** Fully-qualified REST URL for a request, with query parameters. */
  buildUrl(request: GithubRequest): string {
    const root = this.config.apiBaseUrl.replace(/\/+$/, "");
    const path = request.path.replace(/^\/+/, "");
    const url = new URL(`${root}/${path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /**
   * Performs a REST request and returns the parsed JSON body (null for 204).
   * Throws a typed error on any non-2xx.
   */
  async request(request: GithubRequest): Promise<unknown> {
    const method = request.method ?? "GET";
    const url = this.buildUrl(request);
    const response = await this.doFetch(url, {
      method,
      headers: await this.headers(request.body !== undefined),
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    });
    return this.readBody(response, method, url);
  }

  /**
   * Runs a GraphQL operation. GitHub answers a GraphQL error with HTTP 200
   * and an `errors` array, so a 2xx is not enough — the body is inspected and
   * a populated `errors` becomes a GithubResponseError rather than a silent
   * "it worked". Returns the `data` object.
   */
  async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const method: HttpMethod = "POST";
    const url = this.config.graphqlUrl;
    const response = await this.doFetch(url, {
      method,
      headers: await this.headers(true),
      body: JSON.stringify({ query, variables }),
    });
    const body = await this.readBody(response, method, url);
    const envelope = body as { data?: unknown; errors?: unknown } | null;
    const errors = envelope?.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      throw new GithubResponseError(
        "graphql",
        errors.map((e) => {
          const message = (e as { message?: unknown })?.message;
          return typeof message === "string" ? message : JSON.stringify(e);
        }),
      );
    }
    return envelope?.data ?? null;
  }

  private async readBody(response: Response, method: string, url: string): Promise<unknown> {
    if (!response.ok) {
      const snippet = truncate(await safeText(response), BODY_SNIPPET_MAX);
      throw httpError(response.status, method, url, snippet, response.headers);
    }
    if (response.status === 204) return null;
    const text = await safeText(response);
    if (text.trim() === "") return null;
    return JSON.parse(text) as unknown;
  }

  private async headers(hasBody: boolean): Promise<Record<string, string>> {
    const token = await this.token();
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": apiVersionFor(this.config),
    };
    if (hasBody) headers["content-type"] = "application/json";
    return headers;
  }
}

/**
 * Maps an HTTP status onto the driver's error taxonomy. 403 is where GitHub
 * hides its secondary rate limit, so a 403 that carries a rate-limit signal
 * is a retryable throttle, not an auth failure — otherwise the workflow would
 * abandon a run that a short wait would have let through.
 */
function httpError(
  status: number,
  method: string,
  url: string,
  snippet: string,
  headers: Headers,
): GithubHttpError {
  if (status === 429) return new GithubRateLimitError(status, method, url, snippet, true);
  if (status === 403 && isRateLimited(headers, snippet)) {
    return new GithubRateLimitError(status, method, url, snippet, true);
  }
  if (status === 401 || status === 403) return new GithubAuthError(status, method, url, snippet);
  if (status === 404) return new GithubNotFoundError(status, method, url, snippet);
  if (status === 422) return new GithubValidationError(status, method, url, snippet);
  // 5xx is a transport-side fault worth retrying; other 4xx are not.
  return new GithubHttpError(status, method, url, snippet, status >= 500);
}

/** A 403 is a throttle (not an auth denial) when it carries a rate-limit tell. */
function isRateLimited(headers: Headers, snippet: string): boolean {
  if (headers.get("retry-after") !== null) return true;
  if (headers.get("x-ratelimit-remaining") === "0") return true;
  return /rate limit|secondary rate/i.test(snippet);
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
