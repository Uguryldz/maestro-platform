/**
 * Typed failures of the audit trail. Every one of them is a refusal to write or
 * to trust a record: an audit chain that degrades silently is worthless as
 * evidence, so nothing in this package returns a falsy "could not do it" value
 * where a throw is the honest answer (M33).
 */

/** A value could not be serialised deterministically, so it must not be hashed. */
export class AuditCanonicalizationError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`audit: value at ${path} cannot be canonicalised: ${reason}`);
    this.name = "AuditCanonicalizationError";
  }
}

/** An actor string does not match one of the four permitted forms (M101). */
export class AuditActorError extends Error {
  constructor(
    readonly actor: string,
    reason: string,
  ) {
    super(`audit: actor ${JSON.stringify(actor)} is not acceptable: ${reason}`);
    this.name = "AuditActorError";
  }
}

/**
 * A value that goes into the hash is not in the exact form the record stores.
 * Zod's `.trim()` is a *transform*, so hashing a schema's input and storing its
 * output silently produces a record that does not hash to its own fields. Every
 * externally-supplied hashed field is therefore validated fail-closed — the
 * same discipline `assertActor` already applies to `actor`.
 */
export class AuditFieldError extends Error {
  constructor(
    readonly field: string,
    readonly value: string,
    reason: string,
  ) {
    super(`audit: ${field} ${JSON.stringify(value)} is not acceptable: ${reason}`);
    this.name = "AuditFieldError";
  }
}

export type AuditChainErrorReason =
  | "not_an_event"
  | "sequence_conflict"
  | "hash_conflict"
  | "prev_hash_conflict"
  | "head_unreadable"
  | "actor_not_human"
  | "not_self_hashing"
  | "unanchored_slice";

/** The append path refused a record — the chain state is unchanged. */
export class AuditChainError extends Error {
  constructor(
    readonly reason: AuditChainErrorReason,
    detail: string,
  ) {
    super(`audit chain: ${reason} — ${detail}`);
    this.name = "AuditChainError";
  }
}

/** A daily anchor could not be built or does not describe the events given. */
export class AuditAnchorError extends Error {
  constructor(
    readonly reason: string,
    detail: string,
  ) {
    super(`audit anchor: ${reason} — ${detail}`);
    this.name = "AuditAnchorError";
  }
}

/** A record could not be rendered as CEF (bad input, never a silent drop). */
export class AuditExportError extends Error {
  constructor(detail: string) {
    super(`audit export: ${detail}`);
    this.name = "AuditExportError";
  }
}
