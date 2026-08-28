import type { JournalEntry } from "@maestro/contracts";
import type { MaskedJournalEntry } from "./masking.js";

/**
 * Injected clock. Everything in this package that needs "now" takes one, so
 * every test is deterministic and offline (insa-plani §2).
 */
export interface Clock {
  /** ISO-8601 with offset — the shape `contracts.IsoDateTime` accepts. */
  now(): string;
}

/** Wall-clock implementation; wiring code passes this, tests never do. */
export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};

/**
 * The journal's persistence surface — read and append, nothing else.
 *
 * There is deliberately no update and no delete: the database refuses them
 * (append-only triggers, `@maestro/db` migration 0002) and this port refuses
 * to even name them, so the mistake is un-typeable here too (M30).
 *
 * `insert` takes a `MaskedJournalEntry`: an implementation cannot be handed an
 * entry that skipped the PII boundary (M82).
 */
export interface JournalStore {
  /** Highest seq written for `runId`, or null when the run has no entries. */
  maxSeq(runId: string): Promise<number | null>;
  /**
   * Append one entry. MUST reject a duplicate (runId, seq) with
   * `SeqTakenError` — that rejection is what makes concurrent appends safe.
   */
  insert(entry: MaskedJournalEntry): Promise<void>;
  /** Entries of one run in seq order, optionally from `fromSeq` (inclusive). */
  list(runId: string, fromSeq?: number): Promise<JournalEntry[]>;
}

/** What a caller writes; seq and at are generated, masking is automatic. */
export interface JournalDraft {
  readonly runId: string;
  readonly actor: JournalEntry["actor"];
  readonly kind: JournalEntry["kind"];
  readonly title: string;
  readonly detail?: string;
  readonly cost?: JournalEntry["cost"];
  /** Override the clock — for replaying a recorded event at its own time. */
  readonly at?: string;
}
