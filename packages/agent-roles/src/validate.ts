import type { z } from "zod";
import { type AnalysisContext, buildReferenceIndex, isKnownReference } from "./context.js";
import {
  type AnalysisOutput,
  type SourceEntry,
  type SourceKind,
  buildAnalysisSchema,
} from "./schema-builder.js";
import {
  findString,
  isPlaceholder,
  isTemplateEcho,
  isTooShort,
  type OveruseSignal,
  overuse,
  scansForPlaceholders,
} from "./substance.js";
import {
  type AnalysisTemplate,
  claimSections,
  sectionByKey,
  sourceSection,
} from "./template.js";
import { DEFAULT_PROMPT_TEXTS, type PromptTexts, text } from "./texts.js";

/** One concrete, Turkish, model-readable reason the output was refused. */
export interface Deficiency {
  code: string;
  message: string;
}

export type Validation<T> = { ok: true; value: T } | { ok: false; deficiencies: Deficiency[] };

export interface ValidateAnalysisArgs {
  template: AnalysisTemplate;
  context: AnalysisContext;
  value: unknown;
  texts?: PromptTexts;
}

/**
 * Fail-closed analysis validation (M43).
 *
 * Two layers, deliberately separate: the generated schema decides SHAPE (which
 * sections exist, of what form), and the checks below decide TRUTHFULNESS
 * (every claim carries a source, every source points at something the role was
 * actually shown). A document that fails either one never reaches a human gate.
 */
export function validateAnalysis(args: ValidateAnalysisArgs): Validation<AnalysisOutput> {
  const texts = args.texts ?? DEFAULT_PROMPT_TEXTS;
  const parsed = buildAnalysisSchema(args.template).safeParse(args.value);
  if (!parsed.success) {
    return { ok: false, deficiencies: shapeDeficiencies(parsed.error, args, texts) };
  }

  const deficiencies = [
    ...sourceDeficiencies(parsed.data, args.template, args.context, texts),
    ...contentDeficiencies(parsed.data, args.template, texts),
  ];
  return deficiencies.length === 0
    ? { ok: true, value: parsed.data }
    : { ok: false, deficiencies };
}

function rawSections(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return {};
  const sections = (value as { sections?: unknown }).sections;
  if (typeof sections !== "object" || sections === null) return {};
  return sections as Record<string, unknown>;
}

function shapeDeficiencies(
  error: z.ZodError,
  args: ValidateAnalysisArgs,
  texts: PromptTexts,
): Deficiency[] {
  const present = rawSections(args.value);
  const sourcesKey = sourceSection(args.template)?.key;
  const out: Deficiency[] = [];
  const seen = new Set<string>();

  for (const issue of error.issues) {
    const [head, key] = issue.path;
    // An empty Kaynaklar list is a schema error too, but it deserves its own
    // sentence: the analyst must read "sourceless analysis cannot reach a gate".
    const rawSource = key === sourcesKey ? present[key as string] : undefined;
    if (head === "sections" && Array.isArray(rawSource) && rawSource.length === 0) {
      if (seen.has("sources")) continue;
      seen.add("sources");
      out.push({ code: "sources_empty", message: text(texts, "eksik.kaynakBos") });
      continue;
    }
    if (head === "sections" && typeof key === "string" && present[key] === undefined) {
      if (seen.has(key)) continue;
      seen.add(key);
      const title = sectionByKey(args.template, key)?.title ?? key;
      out.push({
        code: "section_missing",
        message: text(texts, "eksik.bolumYok", { bolum: title }),
      });
      continue;
    }
    out.push({
      code: "schema",
      message: text(texts, "eksik.semaHatasi", {
        yol: issue.path.map(String).join(".") || "<kök>",
        mesaj: issue.message,
      }),
    });
  }
  return out;
}

function sourceDeficiencies(
  value: AnalysisOutput,
  template: AnalysisTemplate,
  context: AnalysisContext,
  texts: PromptTexts,
): Deficiency[] {
  const section = sourceSection(template);
  if (!section) return [];
  const entries = (value.sections[section.key] ?? []) as SourceEntry[];
  const out: Deficiency[] = [];

  if (entries.length === 0) {
    out.push({ code: "sources_empty", message: text(texts, "eksik.kaynakBos") });
    return out;
  }

  const index = buildReferenceIndex(context);
  const covered = new Set<string>();
  for (const entry of entries) {
    covered.add(entry.section);
    if (!sectionByKey(template, entry.section)) {
      out.push({
        code: "source_unknown_section",
        message: text(texts, "eksik.kaynakBilinmeyenBolum", { bolum: entry.section }),
      });
    }
    if (!isKnownReference(index, entry.kind as SourceKind, entry.ref)) {
      out.push({
        code: "source_fabricated",
        message: text(texts, "eksik.kaynakUydurma", { ref: entry.ref, tur: entry.kind }),
      });
    }
  }

  // Every section that actually carries claims must be traceable (M109).
  for (const claim of claimSections(template)) {
    if (value.sections[claim.key] === undefined) continue;
    if (covered.has(claim.key)) continue;
    out.push({
      code: "section_unsourced",
      message: text(texts, "eksik.kaynakYok", { bolum: claim.title }),
    });
  }
  return out;
}

/**
 * Content quality: three separate refusals, one section at a time (M43).
 *
 * A section can be shape-perfect and still be a non-answer — a Turkish evasion
 * ("yukarıdaki gibi"), a body under the paragraph the template promised, or the
 * template's own instruction copied back. Each gets its own code and its own
 * Turkish sentence, because the repair round is only useful if the model can
 * tell which of the three it committed.
 */
function contentDeficiencies(
  value: AnalysisOutput,
  template: AnalysisTemplate,
  texts: PromptTexts,
): Deficiency[] {
  const out: Deficiency[] = [];
  for (const section of template.sections) {
    const body = value.sections[section.key];
    if (body === undefined) continue;

    // Echo is checked FIRST: a copied instruction is also short and may also
    // look like a placeholder, and "you repeated the template" is the sentence
    // that actually tells the model what to do differently.
    const echo = findString(body, (s) => isTemplateEcho(section, s));
    if (echo !== undefined) {
      out.push({
        code: "template_echo",
        message: text(texts, "eksik.sablonKopyasi", { bolum: section.title, metin: echo }),
      });
      continue;
    }

    const placeholder = scansForPlaceholders(section)
      ? findString(body, isPlaceholder)
      : undefined;
    if (placeholder !== undefined) {
      out.push({
        code: "placeholder",
        message: text(texts, "eksik.yerTutucu", { bolum: section.title, metin: placeholder }),
      });
      continue;
    }

    if (isTooShort(section, body)) {
      out.push({
        code: "too_short",
        message: text(texts, "eksik.cokKisa", {
          bolum: section.title,
          metin: String(body),
        }),
      });
    }
  }
  return out;
}

/**
 * References leaned on across too many sections — a WARNING, not a refusal.
 *
 * `validateAnalysis` proves every reference exists in the context; it never
 * proves the reference is relevant to the claim beside it. A model that pins
 * every section to one genuine file therefore passes, and always will. This is
 * the cheap smell a reviewer can act on; the judgement stays human.
 */
export function overusedReferences(
  template: AnalysisTemplate,
  value: AnalysisOutput,
): OveruseSignal[] {
  const section = sourceSection(template);
  if (!section) return [];
  const entries = value.sections[section.key];
  if (!Array.isArray(entries)) return [];
  return overuse(template, entries as SourceEntry[]);
}
