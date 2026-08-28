/**
 * Typed notify failures.
 *
 * LEAK RULE — no error in this package may carry a secret: not the Teams/Slack
 * webhook URL (its path IS the credential), not the SMTP password, not an
 * Authorization header. Errors name the driver, the target NAME, the HTTP or
 * SMTP status; never the resolved secret. `redact()` is the last line of
 * defence for text produced elsewhere (a transport error from `fetch` happily
 * echoes the full URL). See test/leak.test.ts.
 */

export class NotifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotifyError";
  }
}

/** Driver configuration or DI wiring is wrong — thrown at construction time. */
export class NotifyConfigError extends NotifyError {
  constructor(reason: string) {
    super(`notify driver configuration error: ${reason}`);
    this.name = "NotifyConfigError";
  }
}

/**
 * The message key is absent from the catalog, or the notification does not
 * satisfy the frozen contract. M104: an unknown key is never silently skipped —
 * a notification nobody can read is a lost gate.
 */
export class NotifyMessageError extends NotifyError {
  constructor(
    readonly messageKey: string,
    reason: string,
  ) {
    super(`notify message "${messageKey}" cannot be rendered: ${reason}`);
    this.name = "NotifyMessageError";
  }
}

/** A recipient is unusable for this channel (unknown target, bad address). */
export class NotifyRecipientError extends NotifyError {
  constructor(
    readonly driver: string,
    readonly recipient: string,
    reason: string,
  ) {
    super(`notify ${driver}: recipient "${recipient}" rejected: ${reason}`);
    this.name = "NotifyRecipientError";
  }
}

/** Retryable: 5xx, 429, SMTP 4xx, socket failure. */
export class NotifyTransientError extends NotifyError {
  constructor(
    readonly driver: string,
    reason: string,
    /** Honoured by the retry loop when the server said Retry-After. */
    readonly retryAfterMs?: number,
  ) {
    super(`notify ${driver}: temporary send failure: ${reason}`);
    this.name = "NotifyTransientError";
  }
}

/** Not retryable: 4xx (except 429), SMTP 5xx, malformed payload. */
export class NotifyPermanentError extends NotifyError {
  constructor(
    readonly driver: string,
    reason: string,
  ) {
    super(`notify ${driver}: permanent send failure: ${reason}`);
    this.name = "NotifyPermanentError";
  }
}

/**
 * Raised when every attempt failed. The caller (Temporal activity) MUST see
 * this: swallowing it is how a gate notification disappears and the work dies
 * in silence.
 *
 * `attempts` always means SEND ATTEMPTS MADE — never "how many targets failed".
 * The fan-out case has its own subclass so the two counts cannot be confused.
 */
export class NotifyDeliveryError extends NotifyError {
  constructor(
    readonly driver: string,
    readonly event: string,
    readonly attempts: number,
    override readonly cause: unknown,
  ) {
    super(
      `notify ${driver}: "${event}" not delivered after ${attempts} attempt(s): ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "NotifyDeliveryError";
  }
}

/** One target's outcome inside a fan-out. `cause` is the driver's own error. */
export interface TargetFailure {
  target: string;
  attempts: number;
  cause: unknown;
}

/**
 * Fan-out failure: some targets were not reached. The individual driver errors
 * are kept as-is in `failures` instead of being wrapped a second time, so a
 * caller can still ask "was this permanent?" without unwrapping two layers.
 */
export class NotifyFanoutError extends NotifyDeliveryError {
  constructor(
    driver: string,
    event: string,
    readonly failures: readonly TargetFailure[],
    readonly targetCount: number,
  ) {
    const attempts = failures.reduce((total, failure) => total + failure.attempts, 0);
    super(driver, event, attempts, failures[0]?.cause);
    this.name = "NotifyFanoutError";
    const summary = failures
      .map((failure) => `${failure.target}: ${safeMessage(failure.cause, [])}`)
      .join(" | ");
    this.message =
      `notify ${driver}: "${event}" not delivered — ${failures.length} of ${targetCount} ` +
      `target(s) failed after ${attempts} attempt(s) — ${summary}`;
  }
}

const MASK = "***";

/**
 * Replace every occurrence of every secret with `***`. Also masks the
 * percent-encoded form, because a URL that reaches an error message is often
 * already encoded. Short strings are ignored: masking a 3-char "password"
 * would blank out unrelated text and hide the real cause.
 */
export function redact(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 4) continue;
    for (const variant of [secret, encodeURIComponent(secret)]) {
      out = out.split(variant).join(MASK);
    }
  }
  return out;
}

/** Message of an unknown throwable, with secrets scrubbed. */
export function safeMessage(error: unknown, secrets: readonly (string | undefined)[]): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redact(raw, secrets);
}
