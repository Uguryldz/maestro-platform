import { redact } from "./redact.js";

/**
 * Typed gateway failures. Every mode the core branches on gets a class —
 * nobody string-matches a message to tell a policy block from an expired key.
 */
export class LlmGatewayError extends Error {}

/** Configuration or wiring is wrong — thrown at construction/first use. */
export class LlmConfigError extends LlmGatewayError {
  constructor(message: string) {
    super(`llm-gateway configuration error: ${message}`);
    this.name = "LlmConfigError";
  }
}

/**
 * Any non-2xx provider response. `responseBody` is truncated for the audit
 * trail (M33), redacted before it is stored, and NON-ENUMERABLE: a provider
 * that echoes the request would otherwise put a key or a customer's TCKN into
 * every `JSON.stringify(error)` a structured logger performs (M19/M82).
 */
export class LlmHttpError extends LlmGatewayError {
  declare readonly responseBody: string;

  constructor(
    readonly status: number,
    readonly driver: string,
    readonly url: string,
    responseBody: string,
    message?: string,
  ) {
    super(message ?? `${driver} ${url} failed with HTTP ${status}`);
    this.name = "LlmHttpError";
    Object.defineProperty(this, "responseBody", { value: redact(responseBody), enumerable: false });
  }
}

/** 401/403 — key missing, revoked or lacking the model entitlement. */
export class LlmAuthError extends LlmHttpError {
  constructor(status: number, driver: string, url: string, body: string) {
    super(status, driver, url, body, `${driver} ${url}: unauthorized (HTTP ${status})`);
    this.name = "LlmAuthError";
  }
}

/** 429 — still throttled after the configured retries. */
export class LlmRateLimitError extends LlmHttpError {
  constructor(driver: string, url: string, body: string, readonly retryAfterMs: number | null) {
    super(429, driver, url, body, `${driver} ${url}: rate limited`);
    this.name = "LlmRateLimitError";
  }
}

/** The provider answered 2xx with a body we cannot read. */
export class LlmResponseError extends LlmGatewayError {
  constructor(readonly driver: string, readonly issues: string[]) {
    super(`${driver}: unexpected response shape: ${issues.join("; ")}`);
    this.name = "LlmResponseError";
  }
}

/** Structured output failed the schema twice (initial + one repair round). */
export class LlmSchemaValidationError extends LlmGatewayError {
  constructor(readonly schemaName: string, readonly attempts: number, readonly issues: string[]) {
    super(`schema "${schemaName}" not satisfied after ${attempts} attempt(s): ${issues.join("; ")}`);
    this.name = "LlmSchemaValidationError";
  }
}

/** No binding for role/variant — M19: an unknown model is an error, never a silent fallback. */
export class UnknownModelError extends LlmGatewayError {
  constructor(readonly role: string, readonly variantId: string) {
    super(`no model binding for role "${role}" / variant "${variantId}"`);
    this.name = "UnknownModelError";
  }
}

// Policy blocks (M18) and quota queues (M55) are deliberately NOT errors: they
// are `LlmOutcome` states the caller branches on. Turning them back into
// exceptions would re-create exactly the message-string matching this file
// exists to prevent.

/** Agent execution is delegated (Wave 2); no runner was wired in. */
export class AgentRunnerNotWiredError extends LlmGatewayError {
  constructor() {
    super("agent session requested but no AgentRunner was injected (Wave 2 execution package)");
    this.name = "AgentRunnerNotWiredError";
  }
}

/** A resume token this gateway never issued — fail-closed, never a fresh session. */
export class UnknownResumeTokenError extends LlmGatewayError {
  constructor(readonly resumeToken: string) {
    super(`unknown resume token "${resumeToken}"`);
    this.name = "UnknownResumeTokenError";
  }
}

/**
 * M58/M18: the routing policy moved while a session was open and no longer
 * agrees with what that session is pinned to. Both answers are wrong — the old
 * backend ignores the new policy, a new backend loses the agent's context — so
 * the turn is refused and the workflow decides what to do with the session.
 */
export class SessionPolicyChangedError extends LlmGatewayError {
  constructor(
    readonly resumeToken: string,
    readonly pinned: string,
    readonly resolved: string,
  ) {
    super(`session "${resumeToken}" is pinned to ${pinned} but the policy now resolves to ${resolved}; refusing the turn`);
    this.name = "SessionPolicyChangedError";
  }
}
