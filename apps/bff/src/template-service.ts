import { humanBehind } from "@maestro/audit";
import type { ResolvedDeps } from "./deps.js";
import type {
  TemplateHistoryEntry,
  TemplateProjectBinding,
  TemplateSection,
  TemplateVersionRecord,
} from "./deps.js";
import { badRequest, conflict, notFound } from "./errors.js";

/**
 * The analysis template designer's write side (M108).
 *
 * Three rules decide everything in this file:
 *
 * 1. **Versions are immutable.** A save PUBLISHES `latest + 1`; it never edits
 *    a published version. The template is what an approved analysis was judged
 *    against, so rewriting version 4 would silently restate what a human
 *    already signed off (M83).
 * 2. **Runs are pinned.** A run resolves its template once, at start, and ends
 *    on that version. Publishing v5 while twelve runs are mid-flight must not
 *    move any of them — which is why nothing here touches open runs, and why
 *    the response reports how many are still pinned to older versions.
 * 3. **The section key is the schema key.** `slugify`/`uniqueKey` run on the
 *    SERVER as well as in Studio: a client that sends colliding or hand-edited
 *    keys would produce a template whose generated Zod schema silently loses a
 *    section.
 */

/** Mirrors `apps/studio/src/screens/template/model.ts` — the same four formats. */
export const SECTION_FORMATS = ["free_text", "bullet_list", "table", "impact_matrix"] as const;
export type SectionFormat = (typeof SECTION_FORMATS)[number];

export interface TemplatePublishRequest {
  name: string;
  sections: readonly unknown[];
  /** Audit actor of the caller (M33). */
  actor: string;
}

export interface TemplateView {
  template: TemplateVersionRecord;
  history: readonly TemplateHistoryEntry[];
  projects: readonly TemplateProjectBinding[];
}

export async function readTemplate(deps: ResolvedDeps): Promise<TemplateView> {
  const [template, history, projects] = await Promise.all([
    deps.templates.latest(),
    deps.templates.history(),
    deps.templates.projects(),
  ]);
  if (template === null) throw notFound("no_template");
  return { template, history, projects };
}

/**
 * Publish a new version.
 *
 * Deliberately NOT four-eyes, and the reason is worth stating because the
 * sibling `putParam` is: a guarded parameter changes who may approve what and
 * when the flow stops (M71/M32), so it takes effect only on a second person's
 * signature. A template version changes what the ANALYST is asked to write —
 * it is then read, judged and approved by a human at the 3→4 gate before it can
 * affect anything. The four eyes are already there, on the document itself, and
 * they are the eyes that matter. Adding a second approver here would gate the
 * QUESTION rather than the ANSWER.
 *
 * What this path does owe the institution is the rest of M83: an immutable
 * version, a full audit entry, and no effect on runs already in flight.
 */
export async function publishTemplateVersion(
  deps: ResolvedDeps,
  request: TemplatePublishRequest,
): Promise<TemplateVersionRecord> {
  const name = request.name.trim();
  if (name.length === 0) throw badRequest("template_name_required");
  const sections = normalizeSections(request.sections);

  const current = await deps.templates.latest();
  const version = (current?.version ?? 0) + 1;
  const at = deps.clock.now().toISOString();

  const record: TemplateVersionRecord = { name, version, sections, publishedBy: request.actor, publishedAt: at };
  // The store re-checks the version is exactly `latest + 1`; two authors saving
  // at once must not both write version 5 and lose one of the drafts.
  try {
    await deps.templates.publish(record);
  } catch {
    throw conflict("template_version_conflict", { expected: version });
  }

  await deps.audit.append({
    actor: request.actor,
    // INTERFACE REQUEST (see RAPOR): `AuditAction` has no
    // `TEMPLATE_VERSION_PUBLISHED`, and `packages/contracts` is frozen.
    // `PARAM_CHANGED` is the closest true statement — a versioned,
    // audited configuration change made from Studio — and the `template:`
    // subject prefix keeps it unambiguous until the enum gains a member.
    action: "PARAM_CHANGED",
    subject: `template:${name}`,
    at,
    meta: {
      kind: "analysis_template",
      version,
      sections: sections.length,
      // The keys are the schema's identity; recording them makes "which
      // sections did version 5 ask for" answerable without the blob.
      keys: sections.map((section) => section.key),
      requiredKeys: sections.filter((section) => section.required).map((section) => section.key),
    },
  });
  return record;
}

/**
 * Validate and canonicalise the incoming sections.
 *
 * Keys are RE-DERIVED here rather than trusted, because a key is the property
 * name of a generated Zod schema. A client that posts two sections carrying the
 * key `kapsam` would produce a schema with ONE property, and every analysis
 * written against that template would silently be missing a section — the
 * failure this whole file exists to prevent.
 *
 * Deriving also constrains the character set: `slugify` emits only `[a-z0-9_]`,
 * so a hand-edited key cannot arrive as `__proto__` (it folds to `proto`) or
 * carry anything that is not a plain identifier. Uniqueness is tracked in a
 * `Set` rather than an object for the same reason.
 */
function normalizeSections(input: readonly unknown[]): TemplateSection[] {
  if (!Array.isArray(input) || input.length === 0) throw badRequest("template_sections_required");
  if (input.length > 60) throw badRequest("template_too_many_sections");

  const taken = new Set<string>();
  return input.map((raw, index) => {
    if (typeof raw !== "object" || raw === null) throw badRequest("template_section_invalid", { index });
    const value = raw as Record<string, unknown>;

    const title = text(value.title);
    if (title.length === 0) throw badRequest("template_section_title_required", { index });
    const format = value.format;
    if (typeof format !== "string" || !SECTION_FORMATS.includes(format as SectionFormat)) {
      throw badRequest("template_section_format_invalid", { index });
    }
    const aiInstruction = text(value.aiInstruction);
    if (aiInstruction.length === 0) throw badRequest("template_section_instruction_required", { index });

    const key = uniqueKey(slugify(title), taken);
    taken.add(key);
    return {
      key,
      title,
      description: text(value.description),
      aiInstruction,
      required: value.required === true,
      format: format as SectionFormat,
      example: text(value.example),
    };
  });
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Turkish letters have no ASCII equivalent under NFD, so they are folded
 * explicitly and BEFORE lowercasing — `"İ".toLowerCase()` is `i` plus a
 * combining dot, which a post-lowercase fold would never match.
 *
 * Kept byte-identical to `apps/studio/src/screens/template/model.ts`: the
 * client shows the author the key their title will produce, and a server that
 * derived a different one would rename sections behind their back.
 */
const TR_FOLD: Readonly<Record<string, string>> = {
  ç: "c", Ç: "c", ğ: "g", Ğ: "g", ı: "i", I: "i", İ: "i",
  ö: "o", Ö: "o", ş: "s", Ş: "s", ü: "u", Ü: "u",
};
const TR_FOLD_RE = /[çÇğĞıIİöÖşŞüÜ]/g;

export function slugify(title: string): string {
  return title
    .replace(TR_FOLD_RE, (ch) => TR_FOLD[ch] ?? ch)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

/** `base`, then `base_2`, `base_3`, … until it is unique against `taken`. */
export function uniqueKey(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const seed = base === "" ? "bolum" : base;
  if (!used.has(seed)) return seed;
  for (let n = 2; ; n += 1) {
    const candidate = `${seed}_${String(n)}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Same human behind two actor strings, seeing through `ai-via:` (M32/M101). */
export function samePerson(left: string, right: string): boolean {
  const leftHuman = humanBehind(left);
  return leftHuman !== null && leftHuman === humanBehind(right);
}
