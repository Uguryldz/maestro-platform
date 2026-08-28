import { z } from "zod";
import { NonEmpty } from "@maestro/contracts";

/**
 * The corporate document template (M103r/M109) — the shape Studio's
 * `Doctemplate.tsx` screen already displays and this package renders against.
 *
 * The institution uploads its own `.docx`; Maestro fills placeholders inside it
 * rather than inventing a layout. This module models WHAT was recognised in
 * that file, not the file itself: the byte-level `.docx` surgery lives in
 * `drivers/docx.ts`, and the same recognised shape drives the PDF so both
 * outputs carry one identity.
 *
 * Nothing here is optional-by-omission. A template that is absent is an
 * explicit `null`, and generation continues on a documented fallback with a
 * WARNING — never a silent default cover (see `TemplateWarning`).
 */

/**
 * Placeholder token in the uploaded `.docx`, e.g. `{{bolum:3}}`.
 *
 * Deliberately narrow: the token is substituted into XML, and a token allowed
 * to carry `<`, `&` or a quote would let a template author (or anyone who can
 * upload one) inject markup into every document the bank produces.
 */
export const PLACEHOLDER_TOKEN = /^\{\{[a-z][a-z0-9_]*(?::[0-9]{1,3})?\}\}$/;

export const PlaceholderToken = z.string().regex(PLACEHOLDER_TOKEN, {
  message: "placeholder must look like {{ad}} or {{bolum:3}}",
});

/**
 * Placeholders whose meaning this package fixes. A template may carry any
 * subset; `{{bolum:N}}` is the indexed family that receives analysis sections.
 */
export const FIXED_PLACEHOLDERS = {
  title: "{{baslik}}",
  ticket: "{{ticket}}",
  run: "{{kosu}}",
  templateVersion: "{{sablon_surumu}}",
  /** Künye table — the reference document leads with it (DOKUMAN-STANDARDI). */
  imprint: "{{kunye}}",
  approvals: "{{onay_tablosu}}",
  body: "{{govde}}",
} as const;

/** `{{bolum:N}}` — section N of the analysis, 1-based as the screen shows it. */
export const SECTION_TOKEN_PREFIX = "bolum";

export function sectionToken(index: number): string {
  return `{{${SECTION_TOKEN_PREFIX}:${String(index)}}}`;
}

/** One placeholder found (or looked for and missed) in the uploaded file. */
export const TemplatePlaceholder = z
  .object({
    token: PlaceholderToken,
    /** Catalog key describing what gets written here (M104) — never prose. */
    descriptionKey: NonEmpty,
    /** Where in the document it sits, as free text from the scan. */
    location: z.string().default(""),
    found: z.boolean(),
  })
  .strict();
export type TemplatePlaceholder = z.infer<typeof TemplatePlaceholder>;

/**
 * The uploaded corporate `.docx`, as recognised.
 *
 * `content` is the raw file. It is kept as bytes rather than a parsed tree
 * because the whole point of M103r is that the bank's cover, header/footer,
 * logo and styles survive untouched: anything this package re-serialises, it
 * can also silently lose.
 */
export const DocTemplateFile = z
  .object({
    fileName: NonEmpty,
    /** Monotonic; a new upload publishes a new version (M83 pins per run). */
    version: z.number().int().positive(),
    uploadedAt: NonEmpty,
    uploadedBy: NonEmpty,
    sizeBytes: z.number().int().nonnegative(),
    /** Style names read out of the `.docx`, shown in Studio. */
    styles: z.array(NonEmpty).default([]),
    placeholders: z.array(TemplatePlaceholder).default([]),
  })
  .strict();
export type DocTemplateFile = z.infer<typeof DocTemplateFile>;

/**
 * Why a generated document is not exactly what the template promised.
 *
 * These are RETURNED, never thrown and never logged-and-forgotten: the Studio
 * screen renders them and the receipt carries them, because "the analysis was
 * published under a default cover" is something a bank's document owner has to
 * be able to see after the fact (fail-closed discipline, 22/22 defects).
 */
export const TemplateWarningCode = z.enum([
  /** No corporate template at all — a plain built-in layout was used. */
  "no_template",
  /** The template had no slot for a section; it was appended at the end. */
  "section_appended",
  /** A fixed placeholder the template does not carry. */
  "placeholder_missing",
  /** The uploaded file could not be read as a `.docx`; fallback was used. */
  "template_unreadable",
]);
export type TemplateWarningCode = z.infer<typeof TemplateWarningCode>;

export const TemplateWarning = z
  .object({
    code: TemplateWarningCode,
    /** Catalog key for the user-facing sentence (M104). */
    messageKey: NonEmpty,
    /** Substitution params for that key — section title, token, … */
    params: z.record(z.string(), z.string()).default({}),
  })
  .strict();
export type TemplateWarning = z.infer<typeof TemplateWarning>;

/**
 * How one analysis section landed in the document. Mirrors the `SectionMapping`
 * rows `Doctemplate.tsx` renders, so the screen can show the same truth the
 * generator acted on.
 */
export interface SectionPlacement {
  /** 1-based position in the rendered document. */
  readonly index: number;
  readonly title: string;
  readonly token: string;
  /** False when the `.docx` had no slot and the section was appended. */
  readonly mapped: boolean;
}

/** What a generator produced, with everything the caller must be able to show. */
export interface GeneratedDocument {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly fileName: string;
  readonly warnings: readonly TemplateWarning[];
  readonly sectionMapping: readonly SectionPlacement[];
}

/** Catalog keys this module's warnings use (M104). */
export const TEMPLATE_MSG = {
  noTemplate: "publish.doc.no_template",
  sectionAppended: "publish.doc.section_appended",
  placeholderMissing: "publish.doc.placeholder_missing",
  templateUnreadable: "publish.doc.template_unreadable",
  imprintPreparedBy: "publish.doc.imprint_prepared_by",
  imprintDate: "publish.doc.imprint_date",
  imprintVersion: "publish.doc.imprint_version",
  imprintScope: "publish.doc.imprint_scope",
  imprintTicket: "publish.doc.imprint_ticket",
  preparedByMaestro: "publish.doc.prepared_by_maestro",
  sources: "publish.doc.sources",
} as const satisfies Record<string, string>;

export function templateMessageKeys(): string[] {
  return Object.values(TEMPLATE_MSG).sort();
}

/**
 * Where a document's bytes are parked so a receipt can point at something
 * durable. Structurally `StoragePort.put`, injected rather than imported: this
 * package must not depend on `@maestro/storage`, and tests must not need S3.
 */
export interface DocumentSink {
  put(key: string, data: Uint8Array, opts?: { contentType?: string; objectLock?: boolean }): Promise<void>;
}
