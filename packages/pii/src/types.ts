import { DataClass, NonEmpty } from "@maestro/contracts";
import { z } from "zod";

/**
 * Detector types, in overlap-resolution priority order: when two detectors
 * claim the same span with the same length, the earlier one wins. IBAN and
 * card come first because they are the longest and the most checksum-bound.
 */
export const DETECTOR_TYPES = ["iban", "card", "tckn", "phone", "email", "account"] as const;
export const DetectorType = z.enum(DETECTOR_TYPES);
export type DetectorType = z.infer<typeof DetectorType>;

/**
 * Everything a token can stand for. `field` is not a detector: it is the
 * field-rule half of M20 ("field + regex") — a named field whose whole value
 * is replaced regardless of what the detectors think of it.
 */
export const PII_TYPES = [...DETECTOR_TYPES, "field"] as const;
export const PiiType = z.enum(PII_TYPES);
export type PiiType = z.infer<typeof PiiType>;

/**
 * Token prefixes. Tokens stay human-readable (`[TCKN_1]`) on purpose: the
 * model has to be able to reason about "the customer's TCKN" without ever
 * seeing it, and a reviewer has to be able to read the masked prompt.
 */
export const TOKEN_PREFIX: Readonly<Record<PiiType, string>> = {
  iban: "IBAN",
  card: "CARD",
  tckn: "TCKN",
  phone: "PHONE",
  email: "EMAIL",
  account: "ACCT",
  field: "FIELD",
};

const PREFIXES = Object.values(TOKEN_PREFIX).join("|");

/** Session nonce grammar: lower-case alphanumerics, so a token stays one word. */
export const TOKEN_NONCE_PATTERN = /^[0-9a-z]{2,16}$/;

/**
 * A minted token: `[TCKN_1.a3f9]`. The suffix is the session nonce, and it is
 * what makes a token mean something only inside the session that minted it.
 * Without it two sessions both minted `[TCKN_1]`, so the wrong map opened the
 * right-looking token and returned another person's identity (verifier B-8),
 * and a `[TCKN_1]` typed by a user was indistinguishable from a real token
 * (B-9). Both regexes are derived from TOKEN_PREFIX rather than spelled out:
 * the minter and the reader must never be able to drift apart.
 */
export const TOKEN_PATTERN_SOURCE = `\\[(${PREFIXES})_(\\d+)\\.([0-9a-z]{2,16})\\]`;

/**
 * Anything token-*shaped*, nonce or not — what a user or a model may have
 * typed. Masking neutralises every one of these that the current session did
 * not mint, so an injected token can never be filled in later.
 */
export const TOKEN_SHAPE_SOURCE = `\\[(?:${PREFIXES})_\\d+(?:\\.[0-9a-z]{2,16})?\\]`;

/** A string that is nothing but a well-formed token — already masked. */
export const WHOLE_TOKEN_PATTERN = new RegExp(`^${TOKEN_PATTERN_SOURCE}$`);

/**
 * Operator-defined identifier shape (customer no, account no, contract no).
 * These have no checksum, so they are opt-in per profile and never active by
 * default in the `acik` profile.
 */
export const AccountPattern = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  /** JS regular expression source. The `g` flag is added by this package. */
  pattern: NonEmpty,
});
export type AccountPattern = z.infer<typeof AccountPattern>;

/** What gets masked for one data class. */
export const MaskProfile = z.object({
  types: z.array(DetectorType).min(1),
  accountPatterns: z.array(AccountPattern).default([]),
  /** Field names (case-insensitive) whose string value is always replaced. */
  fieldRules: z.array(NonEmpty).default([]),
});
export type MaskProfile = z.infer<typeof MaskProfile>;

/**
 * Masking policy (M18/M63: filled in with the compliance team at install
 * time). One profile per data class; an unknown class falls back to `gizli`,
 * which `loadPiiPolicy` forces to cover every detector type.
 */
export const PiiPolicy = z.object({
  profiles: z.object({
    acik: MaskProfile,
    dahili: MaskProfile,
    gizli: MaskProfile,
  }),
});
export type PiiPolicy = z.infer<typeof PiiPolicy>;

export type DataClassName = z.infer<typeof DataClass>;

/** One detected occurrence inside a single string. */
export interface PiiMatch {
  readonly type: DetectorType;
  readonly start: number;
  readonly end: number;
  /** The literal text as it appeared — what `unmask` restores. */
  readonly text: string;
  /** Normalised identity: two spellings of one value share a token. */
  readonly canonical: string;
}

export interface DetectorContext {
  readonly accountPatterns: readonly RegExp[];
}

export interface Detector {
  readonly type: DetectorType;
  scan(text: string, ctx: DetectorContext): PiiMatch[];
}

/**
 * Audit payload (M33 `PII_MASKED`). Counts only — a real value must never be
 * reachable from anything an auditor, a log line or a notification can read.
 */
export interface MaskCounts {
  /** Total replaced occurrences. */
  readonly occurrences: number;
  /** Distinct leaves (JSON fields / whole strings) that changed. */
  readonly fields: number;
  readonly byType: Readonly<Partial<Record<PiiType, number>>>;
}
