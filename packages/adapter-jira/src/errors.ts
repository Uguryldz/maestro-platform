/**
 * Typed failures of the Jira Data Center driver. Every failure mode the core
 * has to branch on gets its own class — callers must never string-match a
 * message to decide whether a gate approval was rejected or the token expired.
 */

/** Base class for every non-2xx REST response. */
export class JiraHttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly url: string,
    /** Truncated response body, kept for the audit trail (M33). */
    readonly responseBody: string,
    message?: string,
  ) {
    super(message ?? `Jira ${method} ${url} failed with HTTP ${status}`);
    this.name = "JiraHttpError";
  }
}

/** 401 — PAT missing, expired or revoked. */
export class JiraAuthError extends JiraHttpError {
  constructor(method: string, url: string, responseBody: string) {
    super(401, method, url, responseBody, `Jira ${method} ${url}: unauthorized (PAT invalid or expired)`);
    this.name = "JiraAuthError";
  }
}

/** 403 — authenticated but the service account lacks the permission (M102 permission set). */
export class JiraForbiddenError extends JiraHttpError {
  constructor(method: string, url: string, responseBody: string) {
    super(403, method, url, responseBody, `Jira ${method} ${url}: forbidden (missing project permission)`);
    this.name = "JiraForbiddenError";
  }
}

/** 404 — issue, comment or group does not exist (or is invisible to the service account). */
export class JiraNotFoundError extends JiraHttpError {
  constructor(method: string, url: string, responseBody: string) {
    super(404, method, url, responseBody, `Jira ${method} ${url}: not found`);
    this.name = "JiraNotFoundError";
  }
}

/** 429 — still throttled after the single permitted backoff. */
export class JiraRateLimitError extends JiraHttpError {
  constructor(
    method: string,
    url: string,
    responseBody: string,
    readonly retryAfterMs: number | null,
  ) {
    super(429, method, url, responseBody, `Jira ${method} ${url}: rate limited`);
    this.name = "JiraRateLimitError";
  }
}

/**
 * 5xx — a transient server-side failure (Cloud driver). The driver never
 * retries in-process (durable retrying is Temporal's job); this class only
 * marks the failure as safe to retry upstream, unlike a 4xx which is final.
 */
export class JiraRetryableError extends JiraHttpError {
  constructor(status: number, method: string, url: string, responseBody: string) {
    super(status, method, url, responseBody, `Jira ${method} ${url}: transient server failure (HTTP ${status})`);
    this.name = "JiraRetryableError";
  }
}

/** 429 and 5xx are worth retrying upstream; every other failure is final. */
export function isRetryableJiraError(error: unknown): boolean {
  return error instanceof JiraRetryableError || error instanceof JiraRateLimitError;
}

/**
 * Webhook signature could not be verified. Verification is fail-closed: this
 * error is thrown for a missing, malformed, or mismatching signature alike, so
 * an unsigned payload can never be mistaken for a verified one.
 */
export class JiraWebhookVerificationError extends Error {
  constructor(readonly reason: "missing_signature" | "malformed_signature" | "mismatch" | "missing_secret") {
    super(`Jira webhook signature verification failed: ${reason}`);
    this.name = "JiraWebhookVerificationError";
  }
}

/** A REST response (or webhook payload) did not carry the fields we require. */
export class JiraResponseError extends Error {
  constructor(
    readonly context: string,
    readonly issues: string[],
  ) {
    super(`Jira response does not match the expected shape (${context}): ${issues.join("; ")}`);
    this.name = "JiraResponseError";
  }
}

/** A caller handed the driver an argument Jira cannot accept. */
export class JiraArgumentError extends Error {
  constructor(
    readonly argument: string,
    reason: string,
  ) {
    super(`Jira driver argument "${argument}" is invalid: ${reason}`);
    this.name = "JiraArgumentError";
  }
}

/**
 * The child issue was created but linking it to its parent failed. Carries the
 * orphan key so the caller can compensate instead of creating a duplicate.
 */
export class JiraLinkFailedError extends Error {
  constructor(
    readonly childKey: string,
    readonly parentKey: string,
    readonly linkError: unknown,
  ) {
    super(`Jira created ${childKey} but could not link it to ${parentKey}`);
    this.name = "JiraLinkFailedError";
  }
}

/**
 * Group membership could not be decided one way or the other. Denying would be
 * fail-closed but silent: a real approver would be turned away at a gate with
 * no way to learn why (M32/M51). Raising instead keeps the failure visible.
 */
export class JiraMembershipUnresolvedError extends Error {
  constructor(
    readonly group: string,
    readonly reason: "incomplete_page_bean" | "too_many_pages" | "contradictory_page",
    detail: string,
  ) {
    super(`Jira group "${group}" membership could not be resolved (${reason}): ${detail}`);
    this.name = "JiraMembershipUnresolvedError";
  }
}

/** Driver configuration or wiring is wrong — thrown at construction time. */
export class JiraConfigError extends Error {
  constructor(message: string) {
    super(`Jira driver configuration error: ${message}`);
    this.name = "JiraConfigError";
  }
}
