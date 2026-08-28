import { LivingSummary, type JournalEntry } from "@maestro/contracts";
import { MemoryArgumentError } from "./errors.js";
import type { JournalMasker } from "./masking.js";
import { buildLivingSummary, SUMMARY_MAX_CHARS, type SummaryOptions } from "./summary.js";
import { clip } from "./summary-format.js";

/** Optional model pass over a finished summary. Never the source of truth. */
export type SummaryEnricher = (input: {
  readonly summary: LivingSummary;
  readonly entries: readonly JournalEntry[];
}) => Promise<string>;

export interface EnrichOptions extends SummaryOptions {
  /** Off by default: no enricher, no model call, no non-determinism. */
  readonly enrich?: SummaryEnricher;
  /** Masks the model's answer before it joins the record (M82). Required with `enrich`. */
  readonly masker?: JournalMasker;
  /** Told when a model pass was dropped, so the caller can journal it. */
  readonly onEnrichFailed?: (error: unknown) => void;
}

const NOTES_HEADING = "\n\n## notes (model)\n";

/**
 * Deterministic summary, optionally with a model-written note appended.
 *
 * The note is *appended*, never substituted: every guaranteed section is
 * already in the text before the model is asked anything, so a hallucinating,
 * failing or unreachable model can subtract nothing. A failed pass returns the
 * deterministic summary unchanged.
 */
export async function enrichLivingSummary(
  runId: string,
  entries: readonly JournalEntry[],
  options: EnrichOptions = {},
): Promise<LivingSummary> {
  const base = buildLivingSummary(runId, entries, options);
  const { enrich, masker } = options;
  if (enrich === undefined) return base;
  if (masker === undefined) {
    throw new MemoryArgumentError("enrichLivingSummary", "an enricher requires a masker (M82)");
  }

  const maxChars = Math.min(options.maxChars ?? SUMMARY_MAX_CHARS, SUMMARY_MAX_CHARS);
  const room = maxChars - base.text.length - NOTES_HEADING.length;
  if (room <= 0) return base;

  let note: string;
  try {
    note = masker.text(await enrich({ summary: base, entries }));
  } catch (error) {
    options.onEnrichFailed?.(error);
    return base;
  }
  const trimmed = clip(note.replace(/\s+$/, ""), room);
  if (trimmed.length === 0) return base;
  return LivingSummary.parse({
    runId: base.runId,
    upToSeq: base.upToSeq,
    text: `${base.text}${NOTES_HEADING}${trimmed}`,
  });
}
