import { z } from "zod";
import { ImpactCell, NonEmpty, RiskTier } from "@maestro/contracts";
import { TemplateError } from "./errors.js";
import { type AnalysisTemplate, type TemplateSection, sourceSection } from "./template.js";

/** Where a claim may come from (M109). Anything else is a fabrication (M98). */
export const SOURCE_KINDS = [
  "repo_file",
  "repo_card",
  "knowledge_doc",
  "ticket",
  "clarification",
] as const;
export const SourceKind = z.enum(SOURCE_KINDS);
export type SourceKind = z.infer<typeof SourceKind>;

/** One row of the "Kaynaklar" section: a claim bound to a verbatim reference. */
export const SourceEntry = z
  .object({
    section: NonEmpty,
    claim: NonEmpty,
    kind: SourceKind,
    ref: NonEmpty,
  })
  .strict();
export type SourceEntry = z.infer<typeof SourceEntry>;

/** One row of "Netleştirilecek açık maddeler" (M109). */
export const OpenItem = z
  .object({
    item: NonEmpty,
    why: NonEmpty,
    owner: NonEmpty.nullable().default(null),
  })
  .strict();
export type OpenItem = z.infer<typeof OpenItem>;

/**
 * Analyst output. `sections` is keyed by template section key, so its inner
 * shape is decided at runtime by the template — that is the whole point of
 * M108. `templateVersion`/`language` are NOT asked of the model: they are
 * pinned by the caller (M83/M59) and stamped in `toAnalysisDoc`.
 */
export interface AnalysisOutput {
  riskTier: RiskTier;
  riskReason: string;
  clarificationsUsed: string[];
  sections: Record<string, unknown>;
}

/** Schema name reported to the gateway; carries the pinned version (M83). */
export function analysisSchemaName(template: AnalysisTemplate): string {
  return `AnalysisDoc@${template.templateId}@${template.version}`;
}

function sectionSchema(section: TemplateSection): z.ZodType {
  const min = section.minItems;
  switch (section.format) {
    case "free_text":
      return NonEmpty;
    case "bullet_list":
      return z.array(NonEmpty).min(min ?? 1);
    case "field_group":
      return z
        .object(Object.fromEntries((section.subFields ?? []).map((f) => [f.key, NonEmpty])))
        .strict();
    case "list_group":
      return z
        .object(
          Object.fromEntries(
            (section.subLists ?? []).map((l) => [l.key, z.array(NonEmpty).min(l.minItems)]),
          ),
        )
        .strict();
    case "table":
      return z
        .array(
          z.object(Object.fromEntries((section.columns ?? []).map((c) => [c, NonEmpty]))).strict(),
        )
        .min(min ?? 1);
    case "impact_matrix":
      return z.array(ImpactCell).min(min ?? 1);
    case "source_list":
      // Empty sources are refused at the schema itself: an analysis with no
      // traceability never even reaches the semantic validator (M109).
      return z.array(SourceEntry).min(Math.max(min ?? 1, 1));
    case "open_items":
      // May be empty — but the key must be present, so "no open items" is a
      // stated answer rather than a silence.
      return z.array(OpenItem);
  }
}

/**
 * Build the analyst's output schema from the template (M108).
 *
 * A template without a `source_list` section cannot produce a traceable
 * analysis, so no schema is produced for it either — the analyst refuses to run
 * instead of quietly dropping the M109 requirement.
 */
export function buildAnalysisSchema(template: AnalysisTemplate): z.ZodType<AnalysisOutput> {
  if (!sourceSection(template)) {
    throw new TemplateError(
      template.templateId,
      'no "source_list" section — an analysis without traceable sources cannot be validated (M109)',
    );
  }

  const shape: Record<string, z.ZodType> = {};
  for (const section of template.sections) {
    const schema = sectionSchema(section);
    shape[section.key] = section.required ? schema : schema.optional();
  }

  return z
    .object({
      riskTier: RiskTier,
      riskReason: NonEmpty,
      clarificationsUsed: z.array(NonEmpty).default([]),
      sections: z.object(shape).strict(),
    })
    .strict() as unknown as z.ZodType<AnalysisOutput>;
}
