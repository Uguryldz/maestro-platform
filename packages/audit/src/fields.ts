import { AuditFieldError } from "./errors.js";

/**
 * Fail-closed rules for the hashed fields the caller supplies verbatim.
 *
 * The contract's `NonEmpty` is `z.string().trim().min(1)` and Zod's `.trim()` is
 * a **transform**: parsing `"UGURPAY-1 "` yields `"UGURPAY-1"`. A seal that
 * hashes the caller's input and stores the schema's output therefore mints a
 * record that does not hash to its own fields — one trailing space in a Jira
 * key, an app name or a runner id is a one-line denial of service against the
 * whole trail. Nothing here normalises: a value that is not already in storage
 * form is refused, exactly as `assertActor` refuses `" user@corp"`.
 */

/** `AuditLog.subject` is `VarChar(128)` in packages/db; a longer value would fail on insert. */
export const SUBJECT_MAX_LENGTH = 128;

export type FieldRejection =
  | "not_a_string"
  | "empty"
  | "untrimmed"
  | "too_long"
  | "not_nfc"
  | "control_character"
  | "not_utc_instant";

/** C0 range plus DEL: a raw newline in a subject splits one CEF line into two. */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Why `subject` would be refused, or `null` when it is acceptable as stored. */
export function subjectRejection(subject: unknown): FieldRejection | null {
  if (typeof subject !== "string") return "not_a_string";
  if (subject.length === 0) return "empty";
  if (subject !== subject.trim()) return "untrimmed";
  if (subject.length > SUBJECT_MAX_LENGTH) return "too_long";
  if (hasControlCharacter(subject)) return "control_character";
  // Two visually identical subjects in different normal forms hash differently
  // and split one ticket's trail into two. One representation is stored: NFC.
  if (subject.normalize("NFC") !== subject) return "not_nfc";
  return null;
}

const REASONS: Record<FieldRejection, string> = {
  not_a_string: "expected a string",
  empty: "must not be empty",
  untrimmed: "has leading or trailing whitespace — the contract would trim it after hashing",
  too_long: `must be at most ${SUBJECT_MAX_LENGTH} characters (packages/db stores VarChar(128))`,
  not_nfc: "is not Unicode NFC — normalise it before recording",
  control_character: "contains a control character",
  not_utc_instant: "is not a UTC ISO instant with millisecond precision (YYYY-MM-DDTHH:MM:SS.sssZ)",
};

/** Fail-closed variant used by the seal path. Returns the value unchanged. */
export function assertSubject(subject: string): string {
  const rejection = subjectRejection(subject);
  if (rejection) throw new AuditFieldError("subject", String(subject), REASONS[rejection]);
  return subject;
}

/**
 * The one instant form the trail stores (M33). The contract accepts offsets,
 * but `packages/db` stores `Timestamptz(3)` and returns `Z`: a record hashed
 * over `…+03:00` comes back from the database as `…Z` and no longer hashes to
 * its own fields. Only the round-trip-stable form is sealed.
 */
export function assertUtcInstant(at: string): string {
  if (typeof at !== "string") throw new AuditFieldError("at", String(at), REASONS.not_a_string);
  const date = new Date(at);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== at) {
    throw new AuditFieldError("at", at, REASONS.not_utc_instant);
  }
  return at;
}
