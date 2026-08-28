import type { FetchLike, TokenProvider } from "../client.js";
import {
  JiraAuthError,
  JiraConfigError,
  JiraForbiddenError,
  JiraHttpError,
  JiraNotFoundError,
  JiraRateLimitError,
  JiraRetryableError,
} from "../errors.js";

export interface JiraCloudClientOptions {
  /** e.g. https://acme.atlassian.net (with or without a trailing slash). */
  baseUrl: string;
  /** Basic-auth username: the e-mail the API token belongs to. */
  email: string;
  /** Supplies the Atlassian API token; injected so secrets never live here. */
  token: TokenProvider;
  /** Defaults to the global fetch; tests inject a stub. */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface JiraCloudRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const BODY_SNIPPET_LIMIT = 500;

/**
 * Thin REST v3 wrapper for Jira Cloud. Even dumber than the DC client: Basic
 * auth (email + API token), JSON in/out, typed errors — and NO in-process
 * retry at all. 429 and 5xx are only CLASSIFIED as retryable
 * (JiraRateLimitError / JiraRetryableError); durable retrying is Temporal's
 * job, and repeating a throttled POST could duplicate a comment or a child.
 */
export class JiraCloudClient {
  private readonly baseUrl: string;
  private readonly email: string;
  private readonly token: TokenProvider;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: JiraCloudClientOptions) {
    const trimmed = options.baseUrl.trim().replace(/\/+$/, "");
    if (trimmed.length === 0) throw new JiraConfigError("baseUrl is empty");
    const email = options.email.trim();
    if (email.length === 0) throw new JiraConfigError("email is empty");
    const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
    if (!fetchImpl) throw new JiraConfigError("no fetch implementation available");

    this.baseUrl = trimmed;
    this.email = email;
    this.token = options.token;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async request<T>(req: JiraCloudRequest): Promise<T> {
    const url = this.buildUrl(req.path, req.query);
    const res = await this.send(req, url);
    return this.handle<T>(req.method, url, res);
  }

  get<T>(path: string, query?: JiraCloudRequest["query"]): Promise<T> {
    return this.request<T>({ method: "GET", path, query });
  }

  /**
   * GET a resource's RAW TEXT by ABSOLUTE URL (an attachment's `content` link).
   * Unlike `get`, it does not JSON-parse and takes a full URL rather than a path,
   * because attachment content lives at a Jira-issued absolute URL. Same Basic
   * auth and timeout as `send`; a non-2xx is a loud error, never silent bytes.
   */
  async getText(absoluteUrl: string): Promise<string> {
    const token = await this.token();
    if (typeof token !== "string" || token.trim().length === 0) {
      throw new JiraConfigError("the resolved API token is empty — refusing to send an unauthenticated request");
    }
    const res = await this.fetchImpl(absoluteUrl, {
      method: "GET",
      headers: {
        authorization: `Basic ${Buffer.from(`${this.email}:${token}`, "utf8").toString("base64")}`,
        accept: "*/*",
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new JiraHttpError(res.status, "GET", absoluteUrl, (await consumeBody(res)).slice(0, BODY_SNIPPET_LIMIT));
    }
    return res.text();
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>({ method: "POST", path, body });
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>({ method: "PUT", path, body });
  }

  /**
   * Upload a single file to a Cloud endpoint as `multipart/form-data`.
   *
   * This is deliberately NOT routed through `request`: attachments are the one
   * write that is not JSON. The body is a native `FormData` (Node 24 ships it,
   * so no `form-data` dependency), and we must NOT set `content-type` ourselves
   * — `fetch` derives the exact `multipart/form-data; boundary=…` header from
   * the FormData, and a hand-set header would drop the boundary and corrupt the
   * upload. The Jira Cloud attachment API additionally requires
   * `X-Atlassian-Token: no-check` (its XSRF guard) or the POST is rejected 403.
   *
   * Same fail-closed auth as `send`: an empty resolved token raises rather than
   * silently downgrading to the anonymous user.
   */
  async postFile<T>(path: string, field: string, file: Blob, filename: string): Promise<T> {
    const token = await this.token();
    if (typeof token !== "string" || token.trim().length === 0) {
      throw new JiraConfigError("the resolved API token is empty — refusing to send an unauthenticated request");
    }
    const url = this.buildUrl(path);
    const form = new FormData();
    form.append(field, file, filename);
    const headers: Record<string, string> = {
      authorization: `Basic ${Buffer.from(`${this.email}:${token}`, "utf8").toString("base64")}`,
      accept: "application/json",
      // XSRF opt-out required by the Jira Cloud attachment endpoint.
      "x-atlassian-token": "no-check",
    };
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return this.handle<T>("POST", url, res);
  }

  private buildUrl(path: string, query?: JiraCloudRequest["query"]): string {
    const url = new URL(this.baseUrl + (path.startsWith("/") ? path : `/${path}`));
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async send(req: JiraCloudRequest, url: string): Promise<Response> {
    const token = await this.token();
    // Fail closed, exactly like the DC client's empty-PAT guard: an empty
    // token would send `Basic base64(email:)` and Cloud would answer as the
    // anonymous user — a silent identity downgrade, not a loud config error.
    if (typeof token !== "string" || token.trim().length === 0) {
      throw new JiraConfigError("the resolved API token is empty — refusing to send an unauthenticated request");
    }
    const headers: Record<string, string> = {
      authorization: `Basic ${Buffer.from(`${this.email}:${token}`, "utf8").toString("base64")}`,
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
        throw new JiraRateLimitError(method, url, body, parseRetryAfter(res.headers.get("retry-after")));
      default:
        if (res.status >= 500) throw new JiraRetryableError(res.status, method, url, body);
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

/** Retry-After is seconds — an HTTP-date is ignored on purpose (as on DC). */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds * 1000;
}
