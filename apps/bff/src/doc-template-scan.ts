import { FIXED_PLACEHOLDERS, sectionToken } from "@maestro/publish";
import type { DocTemplatePlaceholder } from "./deps.js";
import { badRequest } from "./errors.js";
import {
  DOCX_DOCUMENT_ENTRY,
  DOCX_STYLES_ENTRY,
  DocxReadError,
  readZipEntry,
  zipEntryNames,
} from "./docx-zip.js";

/**
 * Reading an uploaded `.docx`: is it really one, what styles does it declare,
 * and which placeholders does it carry.
 *
 * Split from `doc-template-service.ts` because the two answer different
 * questions. That file decides what happens to an upload — versioning, audit,
 * what Studio is told. This one only looks at bytes, takes no dependencies on
 * the container, and is therefore testable against a file with nothing else
 * wired.
 */

/** What each fixed placeholder receives, as catalog keys (M104). */
const FIXED_DESCRIPTIONS: Readonly<Record<string, string>> = {
  [FIXED_PLACEHOLDERS.title]: "doctemplate.what.title",
  [FIXED_PLACEHOLDERS.ticket]: "doctemplate.what.ticket",
  [FIXED_PLACEHOLDERS.run]: "doctemplate.what.run",
  [FIXED_PLACEHOLDERS.templateVersion]: "doctemplate.what.template_version",
  [FIXED_PLACEHOLDERS.imprint]: "doctemplate.what.imprint",
  [FIXED_PLACEHOLDERS.approvals]: "doctemplate.what.approvals",
  [FIXED_PLACEHOLDERS.body]: "doctemplate.what.body",
};

export interface TemplateScan {
  documentXml: string;
  styles: readonly string[];
}

/**
 * Prove the upload is a Word document and pull out what the screen shows.
 *
 * `word/document.xml` is the entry that makes a zip a `.docx`; a zip without
 * it is refused rather than stored as a template that would silently produce
 * the fallback layout for every document from here on.
 */
export function scanTemplate(content: Uint8Array): TemplateScan {
  let names: readonly string[];
  let documentBytes: Uint8Array | null;
  let stylesBytes: Uint8Array | null;
  try {
    names = zipEntryNames(content);
    documentBytes = readZipEntry(content, DOCX_DOCUMENT_ENTRY);
    stylesBytes = readZipEntry(content, DOCX_STYLES_ENTRY);
  } catch (error) {
    if (error instanceof DocxReadError) {
      throw badRequest("doc_template_not_docx", { reason: error.message });
    }
    throw error;
  }

  if (documentBytes === null) {
    throw badRequest("doc_template_not_docx", {
      reason: `archive has no ${DOCX_DOCUMENT_ENTRY} (${String(names.length)} entries)`,
    });
  }

  const documentXml = Buffer.from(documentBytes).toString("utf8");
  // A `word/document.xml` that is not XML at all means the archive is a `.docx`
  // by layout and not by content — a hand-built zip, or a corrupted one.
  if (!documentXml.includes("<w:document") && !documentXml.includes("<?xml")) {
    throw badRequest("doc_template_not_docx", { reason: "word/document.xml is not Word XML" });
  }

  return {
    documentXml,
    styles: stylesBytes === null ? [] : styleNames(Buffer.from(stylesBytes).toString("utf8")),
  };
}

/**
 * Style names declared by the template, as Studio lists them.
 *
 * `w:name` rather than `w:styleId`: the id is the internal token
 * (`Heading1`), the name is what the bank's document author sees in Word
 * ("Başlık 1"), and this list exists so they can recognise their own template.
 */
function styleNames(stylesXml: string): readonly string[] {
  const found = new Set<string>();
  const pattern = /<w:style\b[^>]*>[\s\S]*?<w:name\s+w:val="([^"]{1,128})"/g;
  for (const match of stylesXml.matchAll(pattern)) {
    const name = match[1];
    if (name !== undefined && name.length > 0) found.add(name);
  }
  return [...found].sort();
}

/**
 * Which placeholders the template carries.
 *
 * The scan looks through the raw XML, and that is not a shortcut: Word splits a
 * typed `{{baslik}}` across several `<w:r>` runs the moment a spell-checker or
 * a language mark touches it, so a search of the visible text finds tokens a
 * search of one run would miss. Tags are stripped between the braces for the
 * same reason.
 *
 * `sections` is the analysis template's section titles (M108) — what each
 * `{{bolum:N}}` slot is FOR. Passed in rather than read here so this module
 * stays free of the container.
 */
export function placeholderScan(
  documentXml: string,
  sections: readonly string[],
): readonly DocTemplatePlaceholder[] {
  const text = visibleText(documentXml);

  const fixed = Object.entries(FIXED_DESCRIPTIONS).map(([token, descriptionKey]) => ({
    token,
    descriptionKey,
    location: locate(text, token),
    found: text.includes(token),
  }));

  const slots = sections.map((title, index) => {
    const token = sectionToken(index + 1);
    return {
      token,
      descriptionKey: "doctemplate.what.section",
      // The section's own title, so a missing row says WHICH section has no
      // home rather than only which number.
      location: text.includes(token) ? locate(text, token) : title,
      found: text.includes(token),
    };
  });

  return [...fixed, ...slots];
}

/**
 * The template's text with markup removed, so a token split across runs reads
 * as one string. `<w:p>` becomes a newline first: without it the last word of
 * one paragraph and the first of the next would fuse into a token that is not
 * in the document.
 *
 * Exported because the guidance upload (routes/guidance.ts) extracts the text
 * of an uploaded `.docx` note with the same rules — one extractor, one answer.
 */
export function visibleText(documentXml: string): string {
  return documentXml
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * Where a token sits, as the free text the screen's "location" column shows:
 * the paragraph it appears in, trimmed. Empty when the token is absent — the
 * `found: false` flag is what carries that, and inventing a location for a
 * placeholder the file does not have would be a made-up answer.
 */
function locate(text: string, token: string): string {
  const at = text.indexOf(token);
  if (at === -1) return "";
  const start = text.lastIndexOf("\n", at) + 1;
  const end = text.indexOf("\n", at);
  const line = text.slice(start, end === -1 ? undefined : end).trim();
  const cleaned = line.replace(/\s+/g, " ");
  return cleaned.length > 120 ? `${cleaned.slice(0, 117)}…` : cleaned;
}
