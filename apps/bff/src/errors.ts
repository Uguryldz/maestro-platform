/**
 * HTTP failures. `code` is a stable machine identifier, never prose: every
 * user-facing sentence comes from the message catalog (M104), and an API error
 * body is read by Studio, not by a person.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(code);
    this.name = "HttpError";
  }
}

/**
 * Webhook rejection. Separate from the generic error so the routes cannot
 * accidentally answer 400 to an unauthenticated delivery: a forged body that
 * fails to parse must still be refused as unauthenticated (M15 fail-closed).
 */
export class WebhookRejected extends HttpError {
  constructor(
    readonly source: "jira" | "ado",
    readonly rejectedBy?: unknown,
  ) {
    super(401, "webhook_unauthenticated");
    this.name = "WebhookRejected";
  }
}

export function unauthenticated(code = "unauthenticated"): HttpError {
  return new HttpError(401, code);
}

export function forbidden(code = "forbidden", details?: unknown): HttpError {
  return new HttpError(403, code, details);
}

export function notFound(code = "not_found", details?: unknown): HttpError {
  return new HttpError(404, code, details);
}

export function badRequest(code = "bad_request", details?: unknown): HttpError {
  return new HttpError(400, code, details);
}

export function conflict(code = "conflict", details?: unknown): HttpError {
  return new HttpError(409, code, details);
}

export function unavailable(code = "not_ready", details?: unknown): HttpError {
  return new HttpError(503, code, details);
}
