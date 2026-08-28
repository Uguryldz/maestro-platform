import type { PiiType } from "./types.js";

/** The policy document itself is wrong — thrown at load time, never at call time. */
export class PiiPolicyError extends Error {
  constructor(message: string) {
    super(`PII policy is invalid: ${message}`);
    this.name = "PiiPolicyError";
  }
}

/** A caller handed the masker something it cannot safely traverse. */
export class PiiArgumentError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`PII masking cannot traverse ${path || "<root>"}: ${reason}`);
    this.name = "PiiArgumentError";
  }
}

/**
 * The egress tripwire fired: unmasked PII reached a boundary that only
 * accepts masked payloads. This is v1's fatal bug turned into an exception —
 * v1 wrote the masker and then simply forgot to call it.
 *
 * The message carries types and counts only; the offending values are never
 * put into an error that will end up in a log.
 */
export class PiiLeakError extends Error {
  constructor(
    readonly boundary: string,
    readonly types: readonly PiiType[],
    readonly occurrences: number,
  ) {
    super(
      occurrences === 0
        ? `a payload that never went through the PII boundary reached "${boundary}" ` +
          `(it is not a Masked envelope) — route it through withPiiBoundary() (M20)`
        : `unmasked PII reached the "${boundary}" boundary: ` +
          `${occurrences} occurrence(s) of ${types.join(", ")} — ` +
          `route the payload through withPiiBoundary() (M20)`,
    );
    this.name = "PiiLeakError";
  }
}

/**
 * A masking session was asked for something it cannot be: a nonce that would
 * not survive the token grammar, or a token from a session that is not this
 * one. Tokens are scoped to one session on purpose (M20) — a token that means
 * different people in two sessions is how `unmask` returned the wrong
 * person's identity without an error.
 */
export class PiiSessionError extends Error {
  constructor(message: string) {
    super(`PII masking session is invalid: ${message}`);
    this.name = "PiiSessionError";
  }
}

/**
 * Something tried to serialise a ReverseMap. The map is the one structure in
 * the system that holds token -> real value, so it must never be logged,
 * persisted or sent anywhere (M20/M82).
 */
export class PiiReverseMapLeakError extends Error {
  constructor(readonly operation: string) {
    super(`ReverseMap cannot be serialised (${operation}): it holds unmasked values (M20)`);
    this.name = "PiiReverseMapLeakError";
  }
}
