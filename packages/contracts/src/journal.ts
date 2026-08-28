import { z } from "zod";
import { IsoDateTime, NonEmpty, RunId } from "./common.js";

export const JournalActor = z.enum(["ai", "human", "system"]);
export type JournalActor = z.infer<typeof JournalActor>;

export const JournalKind = z.enum([
  "intake",
  "clarification",
  "discovery",
  "analysis",
  "gate",
  "engineering",
  "scan",
  "review",
  "test_design",
  "test_review",
  "test_run",
  "ci",
  "pr",
  "handover",
  "pii",
  "quota",
  "closure",
  "other",
]);
export type JournalKind = z.infer<typeof JournalKind>;

/**
 * Ticket journal entry. Append-only: the memory package must never mutate
 * or delete entries — the journal is the raw material of the evidence
 * package and the source of the living summary (M30).
 */
export const JournalEntry = z.object({
  runId: RunId,
  seq: z.number().int().nonnegative(),
  at: IsoDateTime,
  actor: JournalActor,
  kind: JournalKind,
  title: NonEmpty,
  detail: z.string().default(""),
  cost: z
    .object({
      usd: z.number().nonnegative().nullable().default(null), // null for subscription drivers (M55)
      tokensIn: z.number().int().nonnegative().optional(),
      tokensOut: z.number().int().nonnegative().optional(),
      model: NonEmpty.optional(),
    })
    .optional(),
});
export type JournalEntry = z.infer<typeof JournalEntry>;

/** Living summary — regenerated from the journal, bounded size (M30). */
export const LivingSummary = z.object({
  runId: RunId,
  upToSeq: z.number().int().nonnegative(),
  text: z.string().max(8000),
});
export type LivingSummary = z.infer<typeof LivingSummary>;
