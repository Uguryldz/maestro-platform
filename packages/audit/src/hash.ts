import { createHash } from "node:crypto";
import { AuditEvent, type AuditAction } from "@maestro/contracts";
import { assertActor } from "./actor.js";
import { canonicalize, canonicalString } from "./canonical.js";
import { AuditChainError } from "./errors.js";
import { assertSubject, assertUtcInstant } from "./fields.js";

export const HASH_ALGORITHM = "sha256" as const;

/** First link of the chain: there is no predecessor to point at. */
export const GENESIS = "genesis" as const;

/** Field separator of the chain input. Strings can never contain it (see canonical.ts). */
const FIELD_SEPARATOR = "|";

/** An audit record before its own hash is known. */
export interface AuditEventCore {
  readonly seq: number;
  readonly at: string;
  readonly actor: string;
  readonly action: AuditAction;
  readonly subject: string;
  readonly prevHash: string;
  readonly meta: Record<string, unknown>;
}

/**
 * The exact byte string that is hashed (M33):
 *   seq | at | actor | action | subject | prevHash | canonical(meta)
 *
 * `actor`, `subject` and `meta` go through the canonical writer, so their
 * escaped form cannot contain the separator; `seq`, `at`, `action` and
 * `prevHash` are constrained by the contract to characters that exclude it.
 * The mapping from record to input is therefore injective: two different
 * records cannot produce the same input string.
 */
export function chainInput(core: AuditEventCore): string {
  return [
    String(core.seq),
    core.at,
    canonicalString(core.actor),
    core.action,
    canonicalString(core.subject),
    core.prevHash,
    canonicalize(core.meta),
  ].join(FIELD_SEPARATOR);
}

/** SHA-256 of the chain input, lower-case hex. */
export function computeEventHash(core: AuditEventCore): string {
  return createHash(HASH_ALGORITHM).update(chainInput(core), "utf8").digest("hex");
}

/** SHA-256 of an arbitrary payload, lower-case hex (anchors, digests). */
export function sha256Hex(payload: string): string {
  return createHash(HASH_ALGORITHM).update(payload, "utf8").digest("hex");
}

/**
 * The contract shape of a record minus its hash: the exact values that are
 * hashed. Hashing this schema's **output** (never a caller's raw input) is what
 * guarantees a sealed record hashes to its own stored fields — `AuditEvent`
 * carries `.trim()` transforms, and hashing before the transform would mint
 * records that fail their own verification.
 */
const HashableEvent = AuditEvent.omit({ hash: true });

/**
 * Seal a core record into a contract-valid `AuditEvent`. Three fail-closed gates
 * run before anything is hashed — actor grammar (M101), `subject` storage form
 * and the UTC instant form — because a normalising seal is how an audit trail
 * quietly stops being evidence. The result is then checked against `rehash`:
 * `sealEvent` never returns a record that does not verify.
 */
export function sealEvent(core: AuditEventCore): AuditEvent {
  assertActor(core.actor);
  assertSubject(core.subject);
  assertUtcInstant(core.at);

  const hashable = HashableEvent.parse(core);
  const event = AuditEvent.parse({ ...hashable, hash: computeEventHash(hashable) });

  if (rehash(event) !== event.hash) {
    // Unreachable while the contract's transforms are idempotent; it exists so
    // a future contract change fails here, loudly, instead of at audit time.
    throw new AuditChainError(
      "not_self_hashing",
      `sealed record seq ${event.seq} does not hash to its own stored fields`,
    );
  }
  return event;
}

/** Recompute the hash of a stored event from its own fields. */
export function rehash(event: AuditEvent): string {
  return computeEventHash({
    seq: event.seq,
    at: event.at,
    actor: event.actor,
    action: event.action,
    subject: event.subject,
    prevHash: event.prevHash,
    meta: event.meta,
  });
}
