/**
 * Typed errors for the Azure DevOps adapter.
 *
 * Every failure path here is explicit: the adapter never returns a
 * half-parsed result and never swallows a non-2xx response (no fail-open).
 */

/** Base class so callers can `catch (e) { if (e instanceof AdoError) ... }`. */
export class AdoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Driver configuration failed Zod validation (wrong mode, missing collection…). */
export class AdoConfigError extends AdoError {
  constructor(readonly issues: string[]) {
    super(`ado: invalid driver configuration:\n- ${issues.join("\n- ")}`);
  }
}

/** Non-2xx HTTP response from the ADO REST API. */
export class AdoHttpError extends AdoError {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly url: string,
    /** Response body, truncated — never logged in full (may echo request data). */
    readonly bodySnippet: string,
  ) {
    super(`ado: ${method} ${url} failed with HTTP ${status}: ${bodySnippet}`);
  }
}

/** 401/403 — PAT missing, expired or lacking the required scope. */
export class AdoAuthError extends AdoHttpError {}

/** 404 — project, repository, pull request or thread does not exist. */
export class AdoNotFoundError extends AdoHttpError {}

/** A 2xx response whose shape does not match what the adapter needs. */
export class AdoResponseError extends AdoError {
  constructor(
    readonly operation: string,
    readonly issues: string[],
  ) {
    super(`ado: unexpected response for ${operation}:\n- ${issues.join("\n- ")}`);
  }
}

/** Service Hook request rejected by the shared-secret check (fail-closed). */
export class AdoWebhookAuthError extends AdoError {
  constructor(readonly reason: "missing" | "malformed" | "mismatch") {
    super(`ado: service hook authentication rejected (${reason})`);
  }
}
