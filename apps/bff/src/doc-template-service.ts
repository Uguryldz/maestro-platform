import { sectionToken } from "@maestro/publish";
import type {
  DocTemplateOutput,
  DocTemplatePlaceholder,
  DocTemplateRecord,
  ResolvedDeps,
} from "./deps.js";
import { placeholderScan, scanTemplate } from "./doc-template-scan.js";
import { badRequest } from "./errors.js";
import { looksLikeZip } from "./docx-zip.js";

/**
 * The corporate Word template's MANAGEMENT (M103r/M109): upload, scan,
 * versioning, and the view Studio's `doctemplate` screen renders.
 *
 * Generation is not here and must not be. `@maestro/publish` already renders
 * `.docx` and PDF against these bytes; this module decides which bytes it gets,
 * whether they are a Word document at all, and what the document owner is told
 * about them.
 *
 * The two halves are separate on purpose. A scan that ran at generation time
 * would tell an operator about a missing placeholder at the moment a bank's
 * analysis was already being published — too late to fix and too late to
 * refuse. Scanning at UPLOAD means the answer exists before the first document
 * does.
 */

/**
 * Largest template this platform accepts.
 *
 * A corporate `.docx` with a logo, a cover and a full style sheet is a few
 * hundred kilobytes; 8 MB leaves room for an embedded font or a scanned
 * letterhead and stays under the server's own body limit, so the refusal comes
 * from here — naming the file and the limit — rather than as Fastify's
 * anonymous 413.
 */
export const MAX_TEMPLATE_BYTES = 8 * 1024 * 1024;

/** How many produced documents the screen's "outputs" card lists. */
export const OUTPUT_LIMIT = 20;

/**
 * `{{bolum:N}}` slots to look for.
 *
 * The screen shows a row per analysis section, and the analysis template (M108)
 * decides how many there are — so the scan looks for as many slots as the
 * CURRENT analysis template has sections, and falls back to this when no
 * analysis template is published yet. Twelve is the number of sections the
 * shipped template carries; scanning for a fixed hundred would fill the screen
 * with rows for sections that do not exist.
 */
export const DEFAULT_SECTION_SLOTS = 12;

/** The wire shape of `GET /doc-template`, exactly as `Doctemplate.tsx` reads it. */
export interface DocTemplateView {
  template: {
    fileName: string;
    version: number;
    uploadedAt: string;
    uploadedBy: string;
    sizeBytes: number;
    styles: readonly string[];
  } | null;
  placeholders: readonly DocTemplatePlaceholder[];
  sectionMapping: readonly SectionMappingView[];
  outputs: readonly DocTemplateOutput[];
}

export interface SectionMappingView {
  index: number;
  title: string;
  token: string;
  /** False when the `.docx` has no slot — the section is appended at the end. */
  mapped: boolean;
}

export interface UploadRequest {
  fileName: string;
  content: Uint8Array;
  /** Audit actor of the uploader (M33). */
  actor: string;
}

/**
 * What Studio shows on the template screen.
 *
 * `template: null` is the real "nobody has uploaded one" and is NOT an error:
 * generation continues on a documented fallback, and the screen renders that
 * as a visible warning. The distinction that matters is the other one — a
 * store that cannot be reached throws, because "no template uploaded" and
 * "the database is unreachable" must never render as the same page.
 */
export async function readDocTemplate(deps: ResolvedDeps): Promise<DocTemplateView> {
  const [record, outputs] = await Promise.all([
    deps.docTemplates.latest(),
    deps.docTemplates.outputs(OUTPUT_LIMIT),
  ]);

  const sections = await analysisSections(deps);

  if (record === null) {
    // No file, so nothing was scanned. The placeholder list is empty rather
    // than a list of "not found" rows: the screen already says "no template",
    // and twelve red rows underneath would read as a broken upload instead of
    // an absent one.
    return {
      template: null,
      placeholders: [],
      sectionMapping: sections.map((title, index) => ({
        index: index + 1,
        title,
        token: sectionToken(index + 1),
        mapped: false,
      })),
      outputs: [...outputs],
    };
  }

  return {
    template: {
      fileName: record.fileName,
      version: record.version,
      uploadedAt: record.uploadedAt,
      uploadedBy: record.uploadedBy,
      sizeBytes: record.sizeBytes,
      styles: [...record.styles],
    },
    placeholders: [...record.placeholders],
    sectionMapping: sections.map((title, index) => ({
      index: index + 1,
      title,
      token: sectionToken(index + 1),
      // Mapped iff the SCAN of this version found the slot. Read from the
      // stored scan, never recomputed: the screen must show what the generator
      // will actually do with the version currently in force.
      mapped: record.placeholders.some(
        (placeholder) => placeholder.token === sectionToken(index + 1) && placeholder.found,
      ),
    })),
    outputs: [...outputs],
  };
}

/**
 * Accept an uploaded `.docx` as a NEW version.
 *
 * Every refusal below is deliberate and none of them is recoverable by
 * retrying with the same file. A corrupt template accepted here is a template
 * that fails at generation time, inside a run, on a bank's ticket — the
 * furthest possible point from the person who could fix it.
 */
export async function uploadDocTemplate(
  deps: ResolvedDeps,
  request: UploadRequest,
): Promise<DocTemplateView> {
  if (request.content.byteLength === 0) throw badRequest("doc_template_empty");
  if (request.content.byteLength > MAX_TEMPLATE_BYTES) {
    throw badRequest("doc_template_too_large", {
      sizeBytes: request.content.byteLength,
      limit: MAX_TEMPLATE_BYTES,
    });
  }
  if (!looksLikeZip(request.content)) {
    // A `.doc`, a PDF renamed, or an HTML error page a proxy substituted for
    // the file. All three arrive looking like an upload and none is a `.docx`.
    throw badRequest("doc_template_not_docx", { reason: "not_a_zip" });
  }

  const scan = scanTemplate(request.content);

  const previous = await deps.docTemplates.latest();
  const version = previous === null ? 1 : previous.version + 1;

  const record: DocTemplateRecord = {
    fileName: request.fileName,
    version,
    uploadedAt: deps.clock.now().toISOString(),
    uploadedBy: request.actor,
    sizeBytes: request.content.byteLength,
    styles: scan.styles,
    placeholders: placeholderScan(scan.documentXml, await analysisSections(deps)),
    content: request.content,
  };

  // Publish first, audit second: an audit line for a version the store rejected
  // would claim a template is in force that nobody can read.
  await deps.docTemplates.publish(record);
  await deps.audit.append({
    actor: request.actor,
    // INTERFACE REQUEST: `AuditAction` (frozen, `@maestro/contracts`) has no
    // `DOC_TEMPLATE_UPLOADED`. `PARAM_CHANGED` is the closest true statement —
    // an upload changes a platform-wide setting that every published document
    // inherits — and the `subject` prefix keeps the events findable. A
    // dedicated action would let an auditor filter for "who changed the
    // letterhead" without reading every parameter change.
    action: "PARAM_CHANGED",
    subject: `doc-template:${String(version)}`,
    at: record.uploadedAt,
    meta: {
      fileName: record.fileName,
      version,
      sizeBytes: record.sizeBytes,
      // The MISSING placeholders, not the found ones: this line exists so an
      // auditor can see what the bank's documents were not going to carry.
      missing: record.placeholders.filter((one) => !one.found).map((one) => one.token),
    },
  });

  return readDocTemplate(deps);
}


/**
 * The analysis template's section titles (M108) — what each `{{bolum:N}}` slot
 * is FOR.
 *
 * Read from the published analysis template rather than hard-coded, because
 * the two templates are edited by different people at different times and the
 * whole point of the mapping card is to show where they disagree. Before the
 * first analysis template is published there are no titles to show, and the
 * scan falls back to counting slots so an uploaded `.docx` is still checked.
 */
async function analysisSections(deps: ResolvedDeps): Promise<readonly string[]> {
  const template = await deps.templates.latest();
  if (template === null || template.sections.length === 0) {
    return Array.from({ length: DEFAULT_SECTION_SLOTS }, (_, index) =>
      `${String(index + 1)}`,
    );
  }
  return template.sections.map((section) => section.title);
}
