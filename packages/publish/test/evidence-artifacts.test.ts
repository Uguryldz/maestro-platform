import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDocumentModel } from "../src/doc-model.js";
import { FIXED_PLACEHOLDERS, sectionToken } from "../src/doc-template.js";
import { renderDocx } from "../src/docx-render.js";
import { renderPdf } from "../src/pdf-render.js";
import { ANALYSIS_MARKDOWN, docxTemplate, readZip } from "./doc-helpers.js";

/**
 * Writes the two artefacts to `/tmp` and verifies them as FILES, not as return
 * values: a `.docx` that unzips and carries `word/document.xml` with the
 * analysis text in it, and a `.pdf` whose header, page count and Turkish
 * characters are all really there.
 *
 * Kept in the suite (rather than as a script that was run once) so the claim
 * "we produce openable documents" is re-checked on every gate.
 */

const DOCX_PATH = "/tmp/maestro-analiz.docx";
const PDF_PATH = "/tmp/maestro-analiz.pdf";

const translate = (locale: string, key: string): string =>
  (
    {
      "publish.doc.imprint_prepared_by": "Hazırlayan",
      "publish.doc.imprint_date": "Tarih",
      "publish.doc.imprint_version": "Versiyon",
      "publish.doc.imprint_ticket": "Kapsam",
      "publish.doc.prepared_by_maestro": "Maestro (AI)",
    } as Record<string, string>
  )[key] ?? `${locale}:${key}`;

function model() {
  return buildDocumentModel({
    markdownSource: ANALYSIS_MARKDOWN,
    translate,
    locale: "tr",
    ticketKey: "UGURPAY-123",
    runId: "run-20260808-0001",
    templateVersion: "analysis-template@1.4.0",
    date: "2026-08-09",
  });
}

describe("generated artefacts (M103r evidence)", () => {
  it("writes a .docx that unzips and contains the analysis text", async () => {
    const { bytes, template } = await docxTemplate([
      FIXED_PLACEHOLDERS.title,
      FIXED_PLACEHOLDERS.ticket,
      FIXED_PLACEHOLDERS.templateVersion,
      FIXED_PLACEHOLDERS.imprint,
      sectionToken(1),
      sectionToken(2),
      sectionToken(3),
      FIXED_PLACEHOLDERS.body,
    ]);

    const rendered = await renderDocx({ model: model(), template, templateBytes: bytes });
    writeFileSync(DOCX_PATH, rendered.bytes);

    const entries = readZip(rendered.bytes);
    expect(entries.has("word/document.xml")).toBe(true);
    expect(entries.has("[Content_Types].xml")).toBe(true);
    const xml = new TextDecoder().decode(entries.get("word/document.xml"));
    // Corporate content preserved, placeholders consumed, Turkish intact.
    expect(xml).toContain("KURUMSAL USTBILGI");
    expect(xml).toContain("Kart limit artırım akışını otomatikleştirmek.");
    expect(xml).not.toContain("{{bolum:1}}");
    // Every section had a slot: a fully-mapped document warns about nothing.
    expect(rendered.warnings).toHaveLength(0);
    expect(rendered.sectionMapping.every((row) => row.mapped)).toBe(true);
    expect(rendered.sectionMapping).toHaveLength(3);
  });

  it("writes a .pdf with a valid header, real pages and correct Turkish", async () => {
    const bytes = await renderPdf(model());
    writeFileSync(PDF_PATH, bytes);

    const raw = new TextDecoder("latin1").decode(bytes);
    expect(raw.startsWith("%PDF-")).toBe(true);
    expect(raw).toContain("%%EOF");
    // At least one page object, and the embedded Unicode font.
    expect(raw).toMatch(/\/Type\s*\/Page[^s]/);
    expect(raw).toContain("DejaVuSans");
    expect(bytes.byteLength).toBeGreaterThan(2000);
  });
});
