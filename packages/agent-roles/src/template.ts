import { z } from "zod";
import { Locale, NonEmpty } from "@maestro/contracts";
import templateJson from "../data/analysis-template.tr.json" with { type: "json" };

/**
 * The analysis template is DATA, not code (M108). Studio's template designer
 * writes exactly this shape; `buildAnalysisSchema` turns it into the Zod schema
 * the analyst is validated against and `buildAnalysisPrompt` turns it into the
 * instructions the analyst is given. Adding a section is therefore a data
 * change — no file in this package is edited for it.
 */

export const SectionKeyName = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/);

/**
 * Expected shape of a section. Six formats are generic (the designer picks
 * them freely); `source_list` and `open_items` carry the M109 semantics that
 * the validator enforces on top of the shape.
 */
export const SectionFormat = z.enum([
  "free_text",
  "bullet_list",
  "field_group",
  "list_group",
  "table",
  "impact_matrix",
  "source_list",
  "open_items",
]);
export type SectionFormat = z.infer<typeof SectionFormat>;

/** Formats whose meaning is fixed by M109 and may appear at most once. */
export const SINGLETON_FORMATS = ["source_list", "open_items"] as const;

const SubField = z.object({ key: SectionKeyName, label: NonEmpty });
export type SubField = z.infer<typeof SubField>;

const SubList = z.object({
  key: SectionKeyName,
  label: NonEmpty,
  minItems: z.number().int().nonnegative().default(0),
});
export type SubList = z.infer<typeof SubList>;

/**
 * Sections may declare which `AnalysisDoc` field they feed. The contract stays
 * the floor (frozen in packages/contracts); a template may add any number of
 * sections beyond it, and those extra sections travel in `TemplatedAnalysis`.
 */
export const ContractField = z.enum([
  "purpose",
  "scope",
  "impactMatrix",
  "acceptanceCriteria",
  "uiApiChanges",
  "testApproach",
  "riskAndRollback",
]);
export type ContractField = z.infer<typeof ContractField>;

export const TemplateSection = z
  .object({
    key: SectionKeyName,
    title: NonEmpty,
    description: z.string().default(""),
    /** Turkish instruction shown to the model verbatim (M59). */
    aiInstruction: NonEmpty,
    /** Few-shot sample of a good answer for this section. */
    example: z.string().default(""),
    required: z.boolean(),
    format: SectionFormat,
    minItems: z.number().int().nonnegative().optional(),
    columns: z.array(NonEmpty).min(1).optional(),
    subFields: z.array(SubField).min(1).optional(),
    subLists: z.array(SubList).min(1).optional(),
    contractField: ContractField.optional(),
  })
  .superRefine((s, ctx) => {
    const need = (present: boolean, field: string, wanted: boolean) => {
      if (wanted && !present) {
        ctx.addIssue({ code: "custom", path: [field], message: `${s.format} requires ${field}` });
      }
      if (!wanted && present) {
        ctx.addIssue({ code: "custom", path: [field], message: `${s.format} must not set ${field}` });
      }
    };
    need(s.columns !== undefined, "columns", s.format === "table");
    need(s.subFields !== undefined, "subFields", s.format === "field_group");
    need(s.subLists !== undefined, "subLists", s.format === "list_group");
  });
export type TemplateSection = z.infer<typeof TemplateSection>;

export const AnalysisTemplate = z
  .object({
    templateId: NonEmpty,
    /** Pinned per run (M83): a flow ends with the version it started on. */
    version: NonEmpty,
    name: NonEmpty,
    locale: Locale,
    sections: z.array(TemplateSection).min(1),
  })
  .superRefine((t, ctx) => {
    const duplicate = (values: readonly string[]) =>
      values.filter((v, i) => values.indexOf(v) !== i);

    for (const key of duplicate(t.sections.map((s) => s.key))) {
      ctx.addIssue({ code: "custom", path: ["sections"], message: `duplicate section key "${key}"` });
    }
    const fields = t.sections.map((s) => s.contractField).filter((f): f is ContractField => !!f);
    for (const field of duplicate(fields)) {
      ctx.addIssue({ code: "custom", path: ["sections"], message: `duplicate contractField "${field}"` });
    }
    for (const format of SINGLETON_FORMATS) {
      if (t.sections.filter((s) => s.format === format).length > 1) {
        ctx.addIssue({ code: "custom", path: ["sections"], message: `at most one "${format}" section` });
      }
    }
  });
export type AnalysisTemplate = z.infer<typeof AnalysisTemplate>;

/** The section that carries M109 traceability, when the template has one. */
export function sourceSection(template: AnalysisTemplate): TemplateSection | undefined {
  return template.sections.find((s) => s.format === "source_list");
}

export function openItemsSection(template: AnalysisTemplate): TemplateSection | undefined {
  return template.sections.find((s) => s.format === "open_items");
}

/** Sections that carry claims and therefore need a source entry (M109/M98). */
export function claimSections(template: AnalysisTemplate): TemplateSection[] {
  return template.sections.filter(
    (s) => s.format !== "source_list" && s.format !== "open_items",
  );
}

export function sectionByKey(template: AnalysisTemplate, key: string): TemplateSection | undefined {
  return template.sections.find((s) => s.key === key);
}

/**
 * Corporate default (M109): the seven-section standard plus "Kaynaklar" and
 * "Netleştirilecek açık maddeler". Studio may add, remove and reorder — this is
 * a starting point, not a hardcoded truth.
 */
export const DEFAULT_ANALYSIS_TEMPLATE: AnalysisTemplate = AnalysisTemplate.parse(templateJson);
