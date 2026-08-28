/**
 * Typed errors for the GitHub adapter.
 *
 * Every failure path is explicit: the adapter never returns a half-parsed
 * result and never swallows a non-2xx response (no fail-open). The class
 * hierarchy mirrors the ADO driver so the orchestrator classifies both SCM
 * drivers the same way.
 */

/** Base class so callers can `catch (e) { if (e instanceof GithubError) ... }`. */
export class GithubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Driver configuration failed Zod validation (missing token ref, bad baseUrl…). */
export class GithubConfigError extends GithubError {
  constructor(readonly issues: string[]) {
    super(`github: invalid driver configuration:\n- ${issues.join("\n- ")}`);
  }
}

/** Non-2xx HTTP response from the GitHub REST/GraphQL API. */
export class GithubHttpError extends GithubError {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly url: string,
    /** Response body, truncated — never logged in full (may echo request data). */
    readonly bodySnippet: string,
    /** True when the status is worth retrying (429, 5xx): a transport hiccup, not a verdict. */
    readonly retryable: boolean = false,
  ) {
    super(`github: ${method} ${url} failed with HTTP ${status}: ${bodySnippet}`);
  }
}

/** 401/403 — token missing, expired, lacking a scope, or the repo is private to it. */
export class GithubAuthError extends GithubHttpError {}

/** 404 — owner, repo, pull request, ref or comment does not exist. */
export class GithubNotFoundError extends GithubHttpError {}

/**
 * 422 — GitHub accepted the request but rejected its content: a branch that
 * already exists, a base sha that is not a commit, a PR whose head/base is
 * invalid. Distinct from a 404 (nothing there) and from a 5xx (try again):
 * the request itself is wrong and retrying it verbatim will fail identically.
 */
export class GithubValidationError extends GithubHttpError {}

/** 429 / secondary-rate-limit — the request was throttled and may be retried later. */
export class GithubRateLimitError extends GithubHttpError {}

/** A 2xx response whose shape does not match what the adapter needs. */
export class GithubResponseError extends GithubError {
  constructor(
    readonly operation: string,
    readonly issues: string[],
  ) {
    super(`github: unexpected response for ${operation}:\n- ${issues.join("\n- ")}`);
  }
}
