import {
  JiraAuthError,
  JiraConfigError,
  JiraForbiddenError,
  JiraHttpError,
  JiraNotFoundError,
  JiraRateLimitError,
} from "./errors.js";

/** Supplies the Personal Access Token; injected so secrets never live here. */
export type TokenProvider = () => string | Promise<string>;

/** Narrow `fetch` shape the client depends on — keeps tests offline. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface JiraDcClientOptions {
  /** e.g. https://jira.internal.bank (with or without a trailing slash). */
  baseUrl: string;
  token: TokenProvider;
  /** Defaults to the global fetch; tests inject a stub. */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Injected so the single 429 backoff is instant in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Upper bound honoured for a Retry-After header. */
  maxBackoffMs?: number;
}

export interface JiraRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 10_000;
const BODY_SNIPPET_LIMIT = 500;

/**
 * Thin REST v2 wrapper for Jira Data Center. Deliberately dumb: PAT bearer
 * auth, JSON in/out, typed errors, and exactly ONE backoff on 429 — no retry
 * storms against a bank's on-prem Jira. Durable retrying is Temporal's job.
 */
export class JiraDcClient {
  private readonly baseUrl: string;
  private readonly token: TokenProvider;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxBackoffMs: number;

  constructor(options: JiraDcClientOptions) {
    const trimmed = options.baseUrl.trim().replace(/\/+$/, "");
    if (trimmed.length === 0) throw new JiraConfigError("baseUrl is empty");
    const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
    if (!fetchImpl) throw new JiraConfigError("no fetch implementation available");

    this.baseUrl = trimmed;
    this.token = options.token;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  }

  async request<T>(req: JiraRequest): Promise<T> {
    const url = this.buildUrl(req.path, req.query);
    const first = await this.send(req, url);

    if (first.status !== 429) return this.handle<T>(req.method, url, first);

    // POST is the one non-idempotent verb here (create comment, create issue,
    // create link). A throttled POST may still have been applied, so retrying
    // it risks a duplicate comment or a duplicate fan-out child — the caller
    // decides, with Temporal's durable retry and its own idempotency key.
    if (req.method === "POST") return this.handle<T>(req.method, url, first);

    // One backoff, then the second 429 is final.
    const retryAfterMs = parseRetryAfter(first.headers.get("retry-after"), this.maxBackoffMs);
    await consumeBody(first);
    await this.sleep(retryAfterMs ?? DEFAULT_BACKOFF_MS);
    const second = await this.send(req, url);
    return this.handle<T>(req.method, url, second);
  }

  get<T>(path: string, query?: JiraRequest["query"]): Promise<T> {
    return this.request<T>({ method: "GET", path, query });
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>({ method: "POST", path, body });
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>({ method: "PUT", path, body });
  }

  private buildUrl(path: string, query?: JiraRequest["query"]): string {
    const url = new URL(this.baseUrl + (path.startsWith("/") ? path : `/${path}`));
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async send(req: JiraRequest, url: string): Promise<Response> {
    const token = await this.token();
    // Fail closed, exactly like the webhook secret: an empty PAT would send
    // `Authorization: Bearer ` and Jira would answer as the anonymous user —
    // a silent identity downgrade instead of a loud configuration error.
    if (typeof token !== "string" || token.trim().length === 0) {
      throw new JiraConfigError("the resolved PAT is empty — refusing to send an unauthenticated request");
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: "application/json",
    };
    const init: RequestInit = { method: req.method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
    if (req.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(req.body);
    }
    return this.fetchImpl(url, init);
  }

  private async handle<T>(method: string, url: string, res: Response): Promise<T> {
    if (res.ok) {
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      if (text.trim().length === 0) return undefined as T;
      return JSON.parse(text) as T;
    }

    const body = (await consumeBody(res)).slice(0, BODY_SNIPPET_LIMIT);
    switch (res.status) {
      case 401:
        throw new JiraAuthError(method, url, body);
      case 403:
        throw new JiraForbiddenError(method, url, body);
      case 404:
        throw new JiraNotFoundError(method, url, body);
      case 429:
        throw new JiraRateLimitError(method, url, body, parseRetryAfter(res.headers.get("retry-after"), this.maxBackoffMs));
      default:
        throw new JiraHttpError(res.status, method, url, body);
    }
  }
}

async function consumeBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/** Retry-After is seconds (Jira DC) — an HTTP-date is ignored on purpose. */
function parseRetryAfter(header: string | null, maxMs: number): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, maxMs);
}
