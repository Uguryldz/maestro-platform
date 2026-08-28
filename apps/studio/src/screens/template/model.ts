/**
 * Analysis template designer — data model (M108).
 *
 * The template is DESIGNED in the Studio, not uploaded. Its section list is
 * turned into a Zod schema on the server and the analyst's output is validated
 * against it, so adding a section must never require a code change.
 *
 * This module is the client-side mirror of that contract. It is pure: no React,
 * no network. Every mutation returns a NEW draft so the editor can keep undoable
 * state and so reordering/deleting can be unit-tested without a DOM.
 *
 * NOTE FOR THE SERVER: `SectionKeyName` (the slug) is the stable identity of a
 * section — it is what the generated Zod schema keys on and what {{bolum:N}}
 * placeholders resolve through. Titles are display text and may be edited
 * freely; keys may not collide. `id` is a client-only editing handle and is
 * NOT persisted.
 */

/** Expected shape of a section's content; drives schema generation. */
export type SectionFormat = "free_text" | "bullet_list" | "table" | "impact_matrix";

export const SECTION_FORMATS: readonly SectionFormat[] = [
  "free_text",
  "bullet_list",
  "table",
  "impact_matrix",
];

/** One designed section. Wire shape — what the BFF stores and returns. */
export interface TemplateSection {
  /**
   * Slug derived from the title, unique within the template. This is the schema
   * key the analyst output is validated against — renaming it is a breaking
   * change and therefore a new template version.
   */
  readonly key: string;
  /** Human-facing section heading, shown in Studio and in the document. */
  readonly title: string;
  /** Human-facing description shown under the heading. */
  readonly description: string;
  /** Instruction to the AI: HOW to fill this section. Goes into the prompt. */
  readonly aiInstruction: string;
  /** Required sections fail closed — a missing one never reaches a human gate. */
  readonly required: boolean;
  readonly format: SectionFormat;
  /** Few-shot example given to the agent as the measure of a good answer. */
  readonly example: string;
}

/** A section plus the client-only editing handle. */
export interface DraftSection extends TemplateSection {
  /** Client-only stable handle; never sent to the server. */
  readonly id: string;
}

/** The whole template as the designer edits it. */
export interface TemplateDraft {
  readonly name: string;
  /** Version currently published; a save publishes `version + 1`. */
  readonly version: number;
  readonly sections: readonly DraftSection[];
  /** Selected section's `id`, or null when nothing is selected. */
  readonly selectedId: string | null;
}

/** Wire shape of a published template version (GET/PUT payload). */
export interface TemplateVersion {
  readonly name: string;
  readonly version: number;
  readonly sections: readonly TemplateSection[];
}

export interface TemplateHistoryEntry {
  readonly version: number;
  readonly at: string;
  readonly author: string;
  readonly summary: string;
}

export interface TemplateProjectBinding {
  readonly projectKey: string;
  /** The version this project resolves to today. */
  readonly version: number;
  /** Open runs still pinned to an older version (M83). */
  readonly pinnedRuns: number;
}

/**
 * Slugify a title into a section key: lowercase ASCII, Turkish letters folded,
 * everything else collapsed to single underscores.
 *
 * Folding matters: "Kapsam" and "Kapsâm" must not both silently become distinct
 * keys, and a Turkish title must produce a key that is valid as a schema
 * property and as a filename.
 */
/**
 * Turkish letters have no ASCII equivalent under NFD, so they are mapped
 * explicitly. Both cases are listed because the fold runs before lowercasing
 * (see `slugify`), and dotless `I` folds to `i` rather than to `ı` — a section
 * key is an ASCII identifier, not Turkish text.
 */
const TR_FOLD: Readonly<Record<string, string>> = {
  ç: "c",
  Ç: "c",
  ğ: "g",
  Ğ: "g",
  ı: "i",
  I: "i",
  İ: "i",
  ö: "o",
  Ö: "o",
  ş: "s",
  Ş: "s",
  ü: "u",
  Ü: "u",
};

/**
 * Fold BEFORE lowercasing.
 *
 * The order matters for exactly one character. `"İ".toLowerCase()` is not `"i"`
 * in JavaScript — it is `"i"` plus U+0307 COMBINING DOT ABOVE — so a fold that
 * ran after `.toLowerCase()` never saw an `İ` at all and its dictionary entry
 * was dead code. The output happened to be correct anyway (the NFD pass strips
 * the combining dot), but a guard that cannot fire is worse than no guard: the
 * next reader trusts it.
 *
 * Folding first makes the mapping the thing that actually does the work, and
 * covers the uppercase forms in the same pass.
 */
const TR_FOLD_RE = /[çÇğĞıIİöÖşŞüÜ]/g;

export function slugify(title: string): string {
  const folded = title
    .replace(TR_FOLD_RE, (ch) => TR_FOLD[ch] ?? ch)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  const slug = folded
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return slug;
}

/**
 * Make `base` unique against `taken`, appending _2, _3, … as needed.
 * An empty base falls back to "bolum" so a title of only punctuation still
 * yields a usable key instead of an empty string.
 */
export function uniqueKey(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const seed = base === "" ? "bolum" : base;
  if (!used.has(seed)) return seed;
  for (let n = 2; ; n += 1) {
    const candidate = `${seed}_${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `s${idCounter}`;
}

/** Attach client-only ids to sections coming off the wire. */
export function toDraftSections(sections: readonly TemplateSection[]): readonly DraftSection[] {
  return sections.map((section) => ({ ...section, id: nextId() }));
}

/** Strip client-only ids for sending back. */
export function toWireSections(sections: readonly DraftSection[]): readonly TemplateSection[] {
  return sections.map(({ id: _id, ...section }) => section);
}

export function selectSection(draft: TemplateDraft, id: string): TemplateDraft {
  return { ...draft, selectedId: id };
}

/**
 * Add a section. The new key is derived from the (translated) default title the
 * caller passes in and made unique, so two "New section" additions in a row
 * produce distinct keys rather than silently colliding.
 */
export function addSection(draft: TemplateDraft, defaults: NewSectionDefaults): TemplateDraft {
  const key = uniqueKey(slugify(defaults.title), draft.sections.map((s) => s.key));
  const section: DraftSection = {
    id: nextId(),
    key,
    title: defaults.title,
    description: "",
    aiInstruction: defaults.aiInstruction,
    required: false,
    format: "free_text",
    example: "",
  };
  return { ...draft, sections: [...draft.sections, section], selectedId: section.id };
}

export interface NewSectionDefaults {
  readonly title: string;
  readonly aiInstruction: string;
}

/**
 * Remove a section. A template must keep at least one section, so removing the
 * last one is refused (returns the draft unchanged) — the caller reports why.
 * Selection moves to a surviving section so the editor never points at a hole.
 */
export function removeSection(draft: TemplateDraft, id: string): TemplateDraft {
  if (draft.sections.length <= 1) return draft;
  const index = draft.sections.findIndex((s) => s.id === id);
  if (index < 0) return draft;
  const sections = draft.sections.filter((s) => s.id !== id);
  const selectedId =
    draft.selectedId === id ? (sections[Math.min(index, sections.length - 1)]?.id ?? null) : draft.selectedId;
  return { ...draft, sections, selectedId };
}

export function canRemoveSection(draft: TemplateDraft): boolean {
  return draft.sections.length > 1;
}

/**
 * Move a section by `delta` positions. Out-of-range moves are no-ops rather
 * than errors so the ↑ button on the first row simply does nothing.
 */
export function moveSection(draft: TemplateDraft, id: string, delta: number): TemplateDraft {
  const from = draft.sections.findIndex((s) => s.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= draft.sections.length) return draft;
  const sections = [...draft.sections];
  const [moved] = sections.splice(from, 1);
  if (moved === undefined) return draft;
  sections.splice(to, 0, moved);
  return { ...draft, sections, selectedId: id };
}

/**
 * Edit one field of one section.
 *
 * Editing the title re-derives the key, kept unique against the OTHER sections.
 * That is what makes "add a section" a no-code operation: the author types a
 * heading and the schema key follows, without ever being able to shadow an
 * existing section's key.
 */
export function updateSection<K extends keyof TemplateSection>(
  draft: TemplateDraft,
  id: string,
  field: K,
  value: TemplateSection[K],
): TemplateDraft {
  const sections = draft.sections.map((section) => {
    if (section.id !== id) return section;
    const next = { ...section, [field]: value } as DraftSection;
    if (field !== "title") return next;
    const others = draft.sections.filter((s) => s.id !== id).map((s) => s.key);
    return { ...next, key: uniqueKey(slugify(next.title), others) };
  });
  return { ...draft, sections };
}

/** True when every section key is distinct — the invariant the schema needs. */
export function keysAreUnique(sections: readonly { key: string }[]): boolean {
  return new Set(sections.map((s) => s.key)).size === sections.length;
}
