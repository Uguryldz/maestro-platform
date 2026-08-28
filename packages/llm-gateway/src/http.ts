import type { RateLimitConfig, RetryConfig } from "./config.js";
import { LlmAuthError, LlmHttpError, LlmRateLimitError, LlmResponseError } from "./errors.js";
import { networkFailureSummary } from "./net-cause.js";
import { insecureFetch, shouldSkipTlsVerify } from "./tls.js";

/** Narrow `fetch` shape the drivers depend on — keeps tests offline. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Everything non-deterministic is injected: no global clock, no global random. */
export interface HttpDeps {
  fetchImpl: FetchLike;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  random: () => number;
}

const BODY_SNIPPET_LIMIT = 500;

/**
 * Token bucket (M19). `take()` does not block — it returns how long the caller
 * must sleep, so the wait is visible and testable instead of hidden in a timer.
 */
export class TokenBucket {
  private tokens: number;
  private lastMs: number;

  constructor(
    private readonly cfg: RateLimitConfig,
    private readonly now: () => Date,
  ) {
    this.tokens = cfg.capacity;
    this.lastMs = now().getTime();
  }

  take(): number {
    const nowMs = this.now().getTime();
    const refill = ((nowMs - this.lastMs) / 1_000) * this.cfg.refillPerSecond;
    this.tokens = Math.min(this.cfg.capacity, this.tokens + Math.max(0, refill));
    this.lastMs = nowMs;

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    const waitMs = Math.ceil(((1 - this.tokens) / this.cfg.refillPerSecond) * 1_000);
    this.tokens = 0;
    return waitMs;
  }
}

export interface JsonRequest {
  driver: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  /**
   * The connection's explicit "skip certificate verification" switch. The
   * internal-address AUTO rule (`needsTlsSkip`) is applied by `postJson`
   * itself on top of this, so the probe and the run cannot drift apart.
   */
  skipTlsVerify?: boolean;
}

/**
 * Physical provider calls made for one logical gateway call (M55). It is an
 * out-parameter rather than a return value on purpose: the retries a call
 * burned must still be known when that call ends in a throw, and a quota that
 * only counts successes under-reports by up to `maxAttempts × repair rounds`.
 */
export class CallCounter {
  #attempts = 0;

  attempt(): void {
    this.#attempts += 1;
  }

  get attempts(): number {
    return this.#attempts;
  }
}

export interface RequestContext {
  deps: HttpDeps;
  bucket: TokenBucket;
  retry: RetryConfig;
  counter?: CallCounter;
}

/**
 * One POST with rate limiting and bounded retries. Retryable: 429, 5xx and
 * transport errors. Never retried: 4xx (a bad request stays bad) and 401/403,
 * which surface immediately so a revoked key is not mistaken for congestion.
 */
export async function postJson(req: JsonRequest, ctx: RequestContext): Promise<unknown> {
  let lastError: Error | undefined;

  // The SAME skip rule the panel's connection probe applies (wendoc's test=run
  // symmetry): the row's explicit switch, or an address that is demonstrably
  // internal. The insecure dial must go through undici's own fetch — the
  // injected `fetchImpl` has no seam a dispatcher could ride through — so on
  // this one path the injected transport is bypassed on purpose. Every test
  // URL is public-shaped, so offline stubs are unaffected.
  const dial = shouldSkipTlsVerify(req.url, req.skipTlsVerify === true)
    ? insecureFetch
    : ctx.deps.fetchImpl;

  for (let attempt = 1; attempt <= ctx.retry.maxAttempts; attempt += 1) {
    const wait = ctx.bucket.take();
    if (wait > 0) await ctx.deps.sleep(wait);

    let res: Response;
    ctx.counter?.attempt();
    try {
      res = await dial(req.url, {
        method: "POST",
        headers: { ...req.headers, "content-type": "application/json" },
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(req.timeoutMs),
      });
    } catch (cause) {
      // The REAL reason sits in the cause chain's `code`s (undici wraps every
      // transport failure in a generic "fetch failed"). Naming it here is what
      // lets a run journal say "TLS sertifikası doğrulanamadı
      // (SELF_SIGNED_CERT_IN_CHAIN)" instead of a bare fetch error — the same
      // classification the panel's connection test renders as a catalog key.
      // Codes only, never the inner message: a message can quote the URL and
      // its headers, and that is where the key lives.
      const summary = networkFailureSummary(cause);
      lastError = new LlmHttpError(
        0,
        req.driver,
        req.url,
        String(cause),
        `${req.driver} ${req.url}: transport error${summary === null ? "" : ` — ${summary}`}`,
      );
      if (attempt < ctx.retry.maxAttempts) await backoff(ctx, attempt, null);
      continue;
    }

    if (res.ok) return parseBody(req.driver, await text(res));

    const body = (await text(res)).slice(0, BODY_SNIPPET_LIMIT);
    if (res.status === 401 || res.status === 403) throw new LlmAuthError(res.status, req.driver, req.url, body);

    const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), ctx.retry.maxDelayMs);
    if (res.status !== 429 && res.status < 500) throw new LlmHttpError(res.status, req.driver, req.url, body);

    lastError =
      res.status === 429
        ? new LlmRateLimitError(req.driver, req.url, body, retryAfterMs)
        : new LlmHttpError(res.status, req.driver, req.url, body);
    if (attempt < ctx.retry.maxAttempts) await backoff(ctx, attempt, retryAfterMs);
  }

  throw lastError ?? new LlmHttpError(0, req.driver, req.url, "", `${req.driver} ${req.url}: no attempt succeeded`);
}

async function backoff(ctx: RequestContext, attempt: number, retryAfterMs: number | null): Promise<void> {
  const exponential = Math.min(ctx.retry.baseDelayMs * 2 ** (attempt - 1), ctx.retry.maxDelayMs);
  const base = retryAfterMs ?? exponential;
  const jitter = ctx.retry.jitterRatio === 0 ? 0 : base * ctx.retry.jitterRatio * (ctx.deps.random() * 2 - 1);
  await ctx.deps.sleep(Math.max(0, Math.round(base + jitter)));
}

function parseBody(driver: string, raw: string): unknown {
  if (raw.trim().length === 0) throw new LlmResponseError(driver, ["empty response body"]);
  try {
    return JSON.parse(raw);
  } catch {
    throw new LlmResponseError(driver, ["response body is not JSON"]);
  }
}

async function text(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/** Retry-After in seconds; an HTTP-date is ignored on purpose. */
function parseRetryAfter(header: string | null, maxMs: number): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1_000, maxMs);
}
