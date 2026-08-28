import {
  Document,
  Header,
  Footer,
  PageNumber,
  Packer,
  Paragraph,
  TextRun,
  AlignmentType,
  LevelFormat,
  patchDocument,
  PatchType,
  type IPatch,
} from "docx";
import type { DocumentModel } from "./doc-model.js";
import {
  FIXED_PLACEHOLDERS,
  sectionToken,
  TEMPLATE_MSG,
  type DocTemplateFile,
  type SectionPlacement,
  type TemplateWarning,
} from "./doc-template.js";
import { blockToDocx, imprintTable, modelToDocx, sectionToDocx } from "./docx-blocks.js";
import { PublishRenderError } from "./errors.js";

/**
 * `.docx` generation (M103r), in two modes.
 *
 * WITH a corporate template: the bank's own file is PATCHED. Its cover, styles,
 * header/footer and logo are never re-serialised by us, because anything this
 * package rebuilds it can also silently lose — and "the logo went missing" is
 * discovered by a regulator, not by a test.
 *
 * WITHOUT one: a plain built-in layout, and a `no_template` warning travels out
 * with the document. Generation does not stop (the Studio screen documents that
 * behaviour), but it is never silent either.
 */

/** Strip the braces: `patchDocument` keys on the bare placeholder name. */
function patchKey(token: string): string {
  return token.replace(/^\{\{|\}\}$/g, "");
}

export interface RenderDocxArgs {
  model: DocumentModel;
  /** The uploaded corporate file, or null when the institution has none. */
  template: DocTemplateFile | null;
  templateBytes: Uint8Array | null;
}

export interface RenderedDocx {
  bytes: Uint8Array;
  warnings: TemplateWarning[];
  sectionMapping: SectionPlacement[];
}

export async function renderDocx(args: RenderDocxArgs): Promise<RenderedDocx> {
  const { model, template, templateBytes } = args;
  if (template === null || templateBytes === null || templateBytes.byteLength === 0) {
    return {
      bytes: await packFallback(model),
      warnings: [{ code: "no_template", messageKey: TEMPLATE_MSG.noTemplate, params: {} }],
      sectionMapping: model.sections.map((section, index) => ({
        index: index + 1,
        title: section.title,
        token: sectionToken(index + 1),
        mapped: false,
      })),
    };
  }
  return patchTemplate(model, template, templateBytes);
}

/**
 * Fill the institution's own `.docx`.
 *
 * A section whose `{{bolum:N}}` slot the template does not carry is APPENDED to
 * the body slot and reported as `section_appended` — never dropped. A template
 * that recognises no body slot at all cannot receive an overflow section, and
 * that is a refusal rather than a half-document (see below).
 */
async function patchTemplate(
  model: DocumentModel,
  template: DocTemplateFile,
  templateBytes: Uint8Array,
): Promise<RenderedDocx> {
  // Readability is settled BEFORE the placeholder metadata is trusted. The
  // scan that produced `template.placeholders` ran at upload time against a
  // file that may since have been replaced by something that is not a `.docx`
  // at all; deciding "section 3 has nowhere to go" from a stale scan would
  // refuse a publish over a template that was never going to be used.
  if (!isZip(templateBytes)) {
    return fallbackFor(model, "not a .docx (missing zip signature)");
  }

  const found = new Set(template.placeholders.filter((p) => p.found).map((p) => p.token));
  const warnings: TemplateWarning[] = [];
  const sectionMapping: SectionPlacement[] = [];
  const patches: Record<string, IPatch> = {};

  const overflow: DocumentModel["sections"][number][] = [];
  model.sections.forEach((section, index) => {
    const token = sectionToken(index + 1);
    const mapped = found.has(token);
    sectionMapping.push({ index: index + 1, title: section.title, token, mapped });
    if (mapped) {
      patches[patchKey(token)] = { type: PatchType.DOCUMENT, children: sectionToDocx(section) };
      return;
    }
    overflow.push(section);
    warnings.push({
      code: "section_appended",
      messageKey: TEMPLATE_MSG.sectionAppended,
      params: { section: section.title, token },
    });
  });

  // Fixed placeholders. Absent ones are reported, not invented: a template
  // without `{{ticket}}` simply does not print the ticket, and the document
  // owner is told which slot is missing.
  const scalars: [string, string][] = [
    [FIXED_PLACEHOLDERS.title, model.title],
    [FIXED_PLACEHOLDERS.ticket, model.imprint.ticket],
    [FIXED_PLACEHOLDERS.templateVersion, model.imprint.version],
  ];
  for (const [token, value] of scalars) {
    if (!found.has(token)) {
      warnings.push({ code: "placeholder_missing", messageKey: TEMPLATE_MSG.placeholderMissing, params: { token } });
      continue;
    }
    patches[patchKey(token)] = { type: PatchType.PARAGRAPH, children: [new TextRun(value)] };
  }

  if (found.has(FIXED_PLACEHOLDERS.imprint)) {
    patches[patchKey(FIXED_PLACEHOLDERS.imprint)] = {
      type: PatchType.DOCUMENT,
      children: [imprintTable(model.imprint)],
    };
  }

  const bodyChildren = [...model.preamble.flatMap(blockToDocx), ...overflow.flatMap(sectionToDocx)];
  if (found.has(FIXED_PLACEHOLDERS.body)) {
    patches[patchKey(FIXED_PLACEHOLDERS.body)] = {
      type: PatchType.DOCUMENT,
      children: bodyChildren.length > 0 ? bodyChildren : [new Paragraph("")],
    };
  } else if (overflow.length > 0) {
    // Sections with nowhere to go. Publishing the rest would hand a human gate
    // a document that LOOKS complete and is missing an entire section.
    throw new PublishRenderError(
      `the corporate template has no ${FIXED_PLACEHOLDERS.body} slot and ` +
        `${String(overflow.length)} section(s) have no {{bolum:N}} placeholder — ` +
        `refusing to publish a document that silently drops them`,
    );
  }

  try {
    const patched = await patchDocument({ outputType: "nodebuffer", data: templateBytes, patches, keepOriginalStyles: true });
    return { bytes: new Uint8Array(patched), warnings, sectionMapping };
  } catch (error) {
    // A zip that is not a Word document, or one the patcher cannot work with.
    // Falling back keeps the run alive; the warning is what tells the document
    // owner their template did nothing.
    return fallbackFor(model, reasonOf(error));
  }
}

/** The no-template layout plus the warning that says why it was used. */
async function fallbackFor(model: DocumentModel, reason: string): Promise<RenderedDocx> {
  return {
    bytes: await packFallback(model),
    warnings: [
      { code: "template_unreadable", messageKey: TEMPLATE_MSG.templateUnreadable, params: { reason } },
    ],
    sectionMapping: model.sections.map((section, index) => ({
      index: index + 1,
      title: section.title,
      token: sectionToken(index + 1),
      mapped: false,
    })),
  };
}

/** `PK\x03\x04` — every `.docx` is a zip; anything else cannot be patched. */
function isZip(bytes: Uint8Array): boolean {
  return bytes.byteLength > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : "unknown";
}

/**
 * The no-template layout. Deliberately plain: it is a FALLBACK, and making it
 * look like a corporate document would hide the fact that the institution's own
 * template never arrived.
 */
async function packFallback(model: DocumentModel): Promise<Uint8Array> {
  const doc = new Document({
    creator: "Maestro",
    title: model.title,
    numbering: {
      config: [
        {
          reference: "maestro-ordered",
          levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.START }],
        },
      ],
    },
    styles: {
      default: {
        document: { run: { font: "DejaVu Sans", size: 22 } },
        heading1: { run: { font: "DejaVu Sans", size: 30, bold: true, color: "1F3864" } },
        heading2: { run: { font: "DejaVu Sans", size: 26, bold: true, color: "1F3864" } },
        title: { run: { font: "DejaVu Sans", size: 40, bold: true, color: "1F3864" } },
      },
    },
    sections: [
      {
        headers: {
          default: new Header({
            children: [new Paragraph({ children: [new TextRun({ text: model.imprint.ticket, bold: true })] })],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ children: [PageNumber.CURRENT, " / ", PageNumber.TOTAL_PAGES] })],
              }),
            ],
          }),
        },
        children: modelToDocx(model),
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}
