import { JournalEntry } from "@maestro/contracts";
import {
  assertNoPii,
  compileProfile,
  maskValue,
  createSessionWith,
  resolveProfile,
  type CompiledProfile,
  type DataClassName,
  type MaskCounts,
  type LoadedPiiPolicy,
} from "@maestro/pii";

declare const JOURNAL_MASKED: unique symbol;

/**
 * Text that has been through the PII boundary (M82).
 *
 * The brand is minted in this module only, so a store or a summary builder
 * typed on `Journaled<…>` cannot be handed a raw string: the journal is kept
 * for ten years (M56) and raw PII must never enter it. The runtime half is
 * `assertNoPii`, which runs on the finished entry — a caller that casts its
 * way past the type still gets a `PiiLeakError` rather than a disclosure.
 */
export type Journaled<T> = T & { readonly [JOURNAL_MASKED]: "journal-masked" };

/** A journal entry that is safe to persist. */
export type MaskedJournalEntry = Journaled<JournalEntry>;

/** The free-text half of an entry — the only part that can carry PII. */
export interface JournalText {
  readonly title: string;
  readonly detail: string;
}

/** Everything about an entry that is generated, not written by a human. */
export interface JournalIdentity {
  readonly runId: string;
  readonly seq: number;
  readonly at: string;
  readonly actor: JournalEntry["actor"];
  readonly kind: JournalEntry["kind"];
  readonly cost?: JournalEntry["cost"];
}

export interface JournalMaskingOptions {
  readonly policy: LoadedPiiPolicy;
  /**
   * Declared data class of the ticket. `unknown` on purpose: it arrives from
   * Jira/webhooks and an unrecognised value must land on the strictest
   * profile instead of throwing (M18/M63 fail-closed).
   */
  readonly dataClass: unknown;
  readonly boundary?: string;
  /** Audit hook (M33 `PII_MASKED`). Receives counts — never values. */
  readonly onMasked?: (counts: MaskCounts, dataClass: DataClassName) => void;
}

/**
 * The masking gate of the memory layer. Every string that reaches the journal,
 * the living summary or the bootstrap package goes through it.
 *
 * One masker holds ONE session (see below), so `[EMAIL_1.<nonce>]` means the
 * same person in every entry that masker writes; two maskers share no token,
 * because the nonce differs. The ReverseMap stays inside the closure and never
 * reaches storage (M20: it is for live display only), so build one masker per
 * run and let it go when the run ends.
 */
export interface JournalMasker {
  readonly dataClass: DataClassName;
  readonly boundary: string;
  /** Mask the free text of an entry. */
  prepare(text: JournalText): Journaled<JournalText>;
  /** Attach the generated fields, validate, and re-check for leaks. */
  seal(identity: JournalIdentity, text: Journaled<JournalText>): MaskedJournalEntry;
  /** Mask a standalone string (summary notes, diff digests, gate reasons). */
  text(value: string): Journaled<string>;
  /** Runtime tripwire for anything assembled outside this module. */
  assertClean(value: unknown, where?: string): void;
}

export function createJournalMasker(options: JournalMaskingOptions): JournalMasker {
  const boundary = options.boundary ?? "journal";
  const resolved = resolveProfile(options.policy, options.dataClass);
  const profile: CompiledProfile = compileProfile(resolved.profile);

  /**
   * ONE session for the masker's whole lifetime. Tokens carry a per-session
   * nonce, so a fresh session per call would not recognise its own earlier
   * output: re-masking an already-masked entry would strip the token's
   * brackets and corrupt the journal. A journal is append-only and read back
   * repeatedly, so masking here must be idempotent.
   */
  const session = createSessionWith(profile);

  const mask = <T>(payload: T): T => {
    const masked = maskValue(payload, session);
    assertNoPii(masked.value, profile, boundary);
    if (options.onMasked && masked.counts.occurrences > 0) {
      options.onMasked(masked.counts, resolved.dataClass);
    }
    // The session's reverse map never leaves this closure: it is the
    // re-identification key and nothing downstream of the journal may hold it.
    return masked.value;
  };

  return {
    dataClass: resolved.dataClass,
    boundary,
    prepare(text: JournalText): Journaled<JournalText> {
      return mask({ title: text.title, detail: text.detail }) as Journaled<JournalText>;
    },
    seal(identity: JournalIdentity, text: Journaled<JournalText>): MaskedJournalEntry {
      const entry = JournalEntry.parse({
        runId: identity.runId,
        seq: identity.seq,
        at: identity.at,
        actor: identity.actor,
        kind: identity.kind,
        title: text.title,
        detail: text.detail,
        ...(identity.cost === undefined ? {} : { cost: identity.cost }),
      });
      assertNoPii(entry, profile, boundary);
      return entry as MaskedJournalEntry;
    },
    text(value: string): Journaled<string> {
      return mask(value) as Journaled<string>;
    },
    assertClean(value: unknown, where?: string): void {
      assertNoPii(value, profile, where === undefined ? boundary : `${boundary}:${where}`);
    },
  };
}
