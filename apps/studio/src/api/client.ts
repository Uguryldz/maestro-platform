import { ApiError, NetworkError, UnauthenticatedError } from "./errors.ts";

export interface RequestOptions {
  readonly method?: "GET" | "POST" | "PUT" | "DELETE";
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly signal?: AbortSignal | undefined;
}

/** Reads the bearer token, or null when signed out. */
export type TokenReader = () => string | null;
/** Called once whenever the server reports the session is gone. */
export type SessionLostHandler = () => void;

export interface ApiClientOptions {
  readonly baseUrl?: string;
  readonly getToken: TokenReader;
  readonly onSessionLost?: SessionLostHandler;
  readonly fetchImpl?: typeof fetch;
}

/** Codes that mean "your session no longer exists" — always route to login. */
const SESSION_LOST_CODES = new Set(["unauthenticated", "session_expired"]);

/**
 * The single door to the BFF. Everything the Studio fetches goes through here.
 *
 * Auth is a bearer token in the Authorization header, not a cookie: the BFF
 * writes no Set-Cookie and registers no CSRF protection, because a header the
 * browser never attaches automatically carries no ambient authority. The token
 * therefore lives in this app's memory (see src/auth/session-store.ts) and is
 * attached explicitly to every request.
 */
export class ApiClient {
  readonly #baseUrl: string;
  readonly #getToken: TokenReader;
  readonly #onSessionLost: SessionLostHandler | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: ApiClientOptions) {
    this.#baseUrl = options.baseUrl ?? "/api";
    this.#getToken = options.getToken;
    this.#onSessionLost = options.onSessionLost;
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  get<T>(path: string, options: Omit<RequestOptions, "method" | "body"> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: "GET" });
  }

  post<T>(path: string, body?: unknown, options: Omit<RequestOptions, "method"> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: "POST", body });
  }

  put<T>(path: string, body?: unknown, options: Omit<RequestOptions, "method"> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: "PUT", body });
  }

  delete<T>(path: string, options: Omit<RequestOptions, "method" | "body"> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: "DELETE" });
  }

  /**
   * POST a RAW binary body (a `.docx` upload), verbatim.
   *
   * Separate from `post` because that one JSON-serialises the body: the
   * corporate template must reach the BFF byte-for-byte (M103r), so the content
   * type is the Word MIME and the bytes are sent unchanged. The file name
   * travels in a header, which is what the BFF reads it from. The same auth and
   * error handling as every other call — nothing here is a second door.
   */
  async postBinary<T>(
    path: string,
    body: ArrayBuffer,
    extraHeaders: Readonly<Record<string, string>> = {},
  ): Promise<T> {
    const headers = new Headers({ accept: "application/json", ...extraHeaders });
    const token = this.#getToken();
    if (token !== null) headers.set("authorization", `Bearer ${token}`);
    if (!headers.has("content-type")) {
      headers.set(
        "content-type",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
    }

    let response: Response;
    try {
      response = await this.#fetch(this.#url(path, {}), { method: "POST", headers, body });
    } catch (cause) {
      if (isAbort(cause)) throw cause;
      throw new NetworkError(cause);
    }
    if (!response.ok) throw await this.#toError(response);
    if (response.status === 204) return undefined as T;
    return (await this.#readJson(response)) as T;
  }

  /** GET a binary body (a `.docx` download) as a Blob, with the same auth. */
  async getBlob(path: string): Promise<Blob> {
    const headers = new Headers();
    const token = this.#getToken();
    if (token !== null) headers.set("authorization", `Bearer ${token}`);

    let response: Response;
    try {
      response = await this.#fetch(this.#url(path, {}), { method: "GET", headers });
    } catch (cause) {
      if (isAbort(cause)) throw cause;
      throw new NetworkError(cause);
    }
    if (!response.ok) throw await this.#toError(response);
    return response.blob();
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const headers = new Headers({ accept: "application/json" });
    const token = this.#getToken();
    if (token !== null) headers.set("authorization", `Bearer ${token}`);

    const hasBody = options.body !== undefined;
    if (hasBody) headers.set("content-type", "application/json");

    const init: RequestInit = {
      method: options.method ?? "GET",
      headers,
      ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    };

    let response: Response;
    try {
      response = await this.#fetch(this.#url(path, options.query), init);
    } catch (cause) {
      // An aborted request is the caller's own doing (component unmounted,
      // query superseded); it must propagate as-is so TanStack Query can
      // recognise the cancellation instead of showing a network error toast.
      if (isAbort(cause)) throw cause;
      throw new NetworkError(cause);
    }

    if (!response.ok) throw await this.#toError(response);

    // 204 No Content: POST /auth/logout answers with an empty body.
    if (response.status === 204) return undefined as T;

    return (await this.#readJson(response)) as T;
  }

  #url(path: string, query: RequestOptions["query"]): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) search.set(key, String(value));
    }
    const qs = search.toString();
    return `${this.#baseUrl}${path}${qs === "" ? "" : `?${qs}`}`;
  }

  async #readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (text === "") return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch (cause) {
      throw new NetworkError(cause);
    }
  }

  async #toError(response: Response): Promise<ApiError> {
    // Never surface the body as prose: read only the machine code. If the body
    // is unparseable (a proxy error page, say) we synthesise a code instead of
    // leaking HTML into the UI.
    let code = "internal_error";
    let details: unknown;
    try {
      const body = (await this.#readJson(response)) as
        | { error?: unknown; details?: unknown }
        | undefined;
      if (body !== undefined && typeof body.error === "string") code = body.error;
      details = body?.details;
    } catch {
      code = "internal_error";
    }

    if (response.status === 401 || SESSION_LOST_CODES.has(code)) {
      this.#onSessionLost?.();
      return new UnauthenticatedError(code, details);
    }
    return new ApiError(response.status, code, details);
  }
}

function isAbort(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "AbortError";
}

export { ApiError, NetworkError, UnauthenticatedError };
