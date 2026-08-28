import type { AnalysisTemplate, TemplateSection } from "./template.js";

/**
 * Content-quality checks: is there an ANSWER in this section, or only something
 * shaped like one?
 *
 * The generated schema proves a section is present and non-empty; it cannot
 * tell "…" or a copied heading from prose. That gap is exactly what M43's
 * fail-closed rule exists to close, because the reader on the other side is a
 * PO at a human gate who would otherwise approve a blank section.
 *
 * All matching folds Turkish's four-way i (i · ı · İ · I) onto one letter
 * before comparing. Plain `toLowerCase` would leave "İŞİN" and "işin" different
 * strings, and `toLocaleLowerCase("tr")` alone still splits I from i — either
 * way a model could slip a copied instruction past the echo check just by
 * shouting it. Comparison must not depend on the host locale at all.
 */

const I_FOLD: Record<string, string> = { İ: "i", I: "i", ı: "i", i: "i" };

/** Fold for comparison: i-family normalised, lowercased, whitespace collapsed. */
export function fold(value: string): string {
  return value
    .replace(/[İIıi]/gu, (c) => I_FOLD[c] ?? c)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Text that looks written but says nothing.
 *
 * The English half is the original list; the Turkish half is what a Turkish
 * model actually writes when it has nothing to say. Both halves matter — the
 * prompts are Turkish, so the escapes are too.
 */
/**
 * Markers that condemn a body wherever they appear, because no real analysis
 * sentence contains them: "TODO: test yaklaşımı sonra yazılacak." is a note to
 * self, not an answer, and the note is what makes it one.
 */
const PLACEHOLDER_MARKERS = [
  "todo",
  "tbd",
  "fixme",
  "xxx",
  "n/a",
  "lorem ipsum",
  "placeholder",
] as const;

/** Words that only condemn a body when they ARE the body (see `isPlaceholder`). */
const PLACEHOLDER_WORDS = [
  // Turkish evasions seen in adversarial runs.
  "yok",
  "bilinmiyor",
  "bilinmemektedir",
  "bilgi yok",
  "veri yok",
  "belirtilmemiş",
  "belirtilmemis",
  "belirsiz",
  "tanımsız",
  "tanimsiz",
  "geçerli değil",
  "gecerli degil",
  "ilgili değil",
  "ilgili degil",
  "uygulanamaz",
  "doldurulacak",
  "doldurulmadı",
  "doldurulmadi",
  "sonra yazılacak",
  "sonra yazilacak",
  "sonra eklenecek",
  "daha sonra",
  "yukarıdaki gibi",
  "yukaridaki gibi",
  "aşağıdaki gibi",
  "asagidaki gibi",
  "yukarıda belirtildiği gibi",
  "yukarida belirtildigi gibi",
  "aynı",
  "ayni",
  "aynısı",
  "aynisi",
  "değişiklik yok",
  "degisiklik yok",
  "not applicable",
  "none",
  "unknown",
] as const;

/**
 * Bodies that carry no information at all regardless of language: ellipses,
 * dashes, a lone letter, a lone digit. Matched on the WHOLE value, because
 * a dash inside a sentence is punctuation, not an evasion.
 */
const EMPTY_BODY = /^[\s.\-—–_*·•…?xX0-9]*$/u;

/**
 * True when the string is a placeholder rather than an answer.
 *
 * Two rules, deliberately different in strictness:
 *  - `EMPTY_BODY` matches the whole value, so "-" fails but "geri-dönüş planı
 *    hazır" passes.
 *  - a placeholder WORD only counts when it is essentially the entire body
 *    (up to a short tail), so "Değişiklik yok." fails while a real paragraph
 *    that happens to contain "bilinmiyor" in a clause does not.
 *
 * The strictness is scoped by the CALLER, not by this function: in a table cell
 * or a source-list field, "-" and "yok" are legitimate tabular answers ("no
 * backward-compat concern"), while as a section body they are the evasion M43
 * exists to refuse. `scanPlaceholders` decides which leaves are section bodies.
 */
export function isPlaceholder(value: string): boolean {
  const folded = fold(value);
  if (folded.length === 0) return true;
  if (EMPTY_BODY.test(value)) return true;
  if (PLACEHOLDER_MARKERS.some((marker) => new RegExp(`\\b${marker}\\b`, "u").test(folded))) {
    return true;
  }

  const bare = folded.replace(/[.!?;:,]+$/u, "").trim();
  return PLACEHOLDER_WORDS.some((word) => bare === word || bare === `(${word})`);
}

/**
 * Formats whose leaves are PROSE the analyst owes, so every leaf is scanned.
 *
 * The row-shaped formats (`table`, `impact_matrix`, `source_list`,
 * `open_items`) are excluded: their cells are short structured values where a
 * dash or a "yok" is the correct answer, and their integrity is already
 * enforced elsewhere — source rows against the reference index, impact rows
 * against `ImpactCell`. Scanning them for prose would refuse valid documents,
 * which is the same failure as letting invalid ones through.
 */
const PROSE_FORMATS = new Set(["free_text", "bullet_list", "field_group", "list_group"]);

export function scansForPlaceholders(section: TemplateSection): boolean {
  return PROSE_FORMATS.has(section.format);
}

/**
 * Minimum substance for a `free_text` section.
 *
 * The template PROMISES "en az iki cümlelik düz paragraf" in `bicim.free_text`
 * and nothing used to check it, so a model could satisfy the schema with a
 * three-word clause. These floors are deliberately low: they refuse a
 * non-answer, they do not grade prose. Judging whether the paragraph is GOOD is
 * the human gate's job.
 */
export const MIN_FREE_TEXT_WORDS = 8;
export const MIN_FREE_TEXT_SENTENCES = 2;

export function isTooShort(section: TemplateSection, value: unknown): boolean {
  if (section.format !== "free_text") return false;
  if (typeof value !== "string") return false;
  const words = fold(value).split(" ").filter(Boolean);
  if (words.length < MIN_FREE_TEXT_WORDS) return true;
  const sentences = value.split(/[.!?…]+/u).filter((s) => s.trim().length > 0);
  return sentences.length < MIN_FREE_TEXT_SENTENCES;
}

/**
 * The section's own template text, echoed back as if it were an answer.
 *
 * A model that copies the title, the description or the AI instruction has
 * produced a section that passes every shape check and answers nothing. The
 * comparison is on folded text so casing and stray whitespace do not let it
 * through.
 */
export function isTemplateEcho(section: TemplateSection, value: string): boolean {
  const folded = fold(value);
  if (folded.length === 0) return false;
  return [section.title, section.description, section.aiInstruction, section.example]
    .filter((t) => t.trim().length > 0)
    .some((t) => fold(t) === folded);
}

/** Walk a section value, returning the first string that fails `predicate`. */
export function findString(
  value: unknown,
  predicate: (text: string) => boolean,
): string | undefined {
  if (typeof value === "string") return predicate(value) ? value : undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findString(item, predicate);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) {
      const hit = findString(item, predicate);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/** One reference cited across suspiciously many sections. */
export interface OveruseSignal {
  ref: string;
  sections: string[];
}

/**
 * How many distinct sections may lean on a single reference before it looks
 * like the model found one real file and pinned every claim to it.
 */
export const REFERENCE_OVERUSE_LIMIT = 3;

/**
 * A SIGNAL, never a refusal.
 *
 * Source checking proves a reference EXISTS in the context; it cannot prove the
 * reference is RELEVANT to the claim. A model that cites one genuine file for
 * every section passes validation and always will — relevance is what the human
 * gate reads for. This surfaces the smell so a reviewer can look, and it
 * deliberately does not block: a small template where three sections honestly
 * share one file must not be refused.
 */
export function overuse(
  template: AnalysisTemplate,
  entries: readonly { section: string; ref: string }[],
): OveruseSignal[] {
  const byRef = new Map<string, Set<string>>();
  for (const entry of entries) {
    const ref = entry.ref.trim();
    const sections = byRef.get(ref) ?? new Set<string>();
    sections.add(entry.section);
    byRef.set(ref, sections);
  }

  const claimCount = template.sections.length;
  return [...byRef.entries()]
    .filter(([, sections]) => sections.size > REFERENCE_OVERUSE_LIMIT && sections.size > 1)
    .filter(([, sections]) => sections.size >= Math.min(claimCount, REFERENCE_OVERUSE_LIMIT + 1))
    .map(([ref, sections]) => ({ ref, sections: [...sections].sort() }));
}
