import { describe, expect, it } from "vitest";
import type { PublishRequest } from "@maestro/contracts";
import { buildDocumentModel } from "../src/doc-model.js";
import { FIXED_PLACEHOLDERS, sectionToken, type DocTemplateFile } from "../src/doc-template.js";
import { renderDocx } from "../src/docx-render.js";
import {
  BinaryDocPublisher,
  BinaryDocPublishConfig,
  type BinaryDocPublisherDeps,
} from "../src/drivers/binary-doc.js";
import { PublishRenderError } from "../src/errors.js";
import { renderPdf } from "../src/pdf-render.js";
import { InMemoryPublishState } from "../src/types.js";
import { fakeTranslate, RUN_ID, TICKET, runContext } from "./helpers.js";
import { ANALYSIS_MARKDOWN, brandedDocxTemplate, docxTemplate, unzip } from "./doc-helpers.js";

/**
 * M103r. These tests assert on the BYTES: a `.docx` that is not a zip carrying
 * `word/document.xml`, or a `.pdf` without a `%PDF` header, is not a document —
 * and "the driver returned successfully" has never been evidence that it is.
 */

const REQ: PublishRequest = { runId: RUN_ID, doc: "analysis", targets: ["docx"], locale: "tr" };

function model(markdown = ANALYSIS_MARKDOWN) {
  return buildDocumentModel({
    markdownSource: markdown,
    translate: fakeTranslate(),
    locale: "tr",
    ticketKey: TICKET,
    runId: RUN_ID,
    templateVersion: "analysis-template@1.4.0",
    date: "2026-08-09",
  });
}

interface StoredObject {
  bytes: Uint8Array;
  contentType?: string;
  objectLock?: boolean;
}

function publisher(
  target: "docx" | "pdf",
  overrides: Partial<BinaryDocPublisherDeps> = {},
): { publisher: BinaryDocPublisher; stored: Map<string, StoredObject> } {
  const stored = new Map<string, StoredObject>();
  const deps: BinaryDocPublisherDeps = {
    sink: {
      put: (key, bytes, opts) => {
        stored.set(key, { bytes, contentType: opts?.contentType, objectLock: opts?.objectLock });
        return Promise.resolve();
      },
    },
    state: new InMemoryPublishState(),
    runContext: runContext(),
    translate: fakeTranslate(),
    now: () => new Date("2026-08-09T10:00:00.000Z"),
    ...overrides,
  };
  return { publisher: new BinaryDocPublisher(target, BinaryDocPublishConfig.parse({}), deps), stored };
}

describe("docx rendering (M103r)", () => {
  it("produces a real .docx: zip magic plus word/document.xml", async () => {
    const rendered = await renderDocx({ model: model(), template: null, templateBytes: null });

    expect(rendered.bytes.byteLength).toBeGreaterThan(1000);
    expect(Array.from(rendered.bytes.slice(0, 2))).toEqual([0x50, 0x4b]); // "PK"
    const entries = await unzip(rendered.bytes);
    expect(entries.has("word/document.xml")).toBe(true);
    const xml = new TextDecoder().decode(entries.get("word/document.xml"));
    expect(xml).toContain("Kart limit");
  });

  it("warns when the institution has no template instead of passing silently", async () => {
    const rendered = await renderDocx({ model: model(), template: null, templateBytes: null });

    expect(rendered.warnings.map((w) => w.code)).toEqual(["no_template"]);
    expect(rendered.sectionMapping.every((row) => !row.mapped)).toBe(true);
  });

  it("fills a corporate template's placeholders and keeps its own content", async () => {
    const { bytes, template } = await docxTemplate([
      FIXED_PLACEHOLDERS.title,
      FIXED_PLACEHOLDERS.ticket,
      sectionToken(1),
      FIXED_PLACEHOLDERS.body,
    ]);

    const rendered = await renderDocx({ model: model(), template, templateBytes: bytes });

    const xml = new TextDecoder().decode((await unzip(rendered.bytes)).get("word/document.xml"));
    expect(xml).toContain("KURUMSAL USTBILGI"); // the bank's own text survived
    expect(xml).not.toContain("{{baslik}}"); // the placeholder was consumed
    expect(rendered.warnings.filter((w) => w.code === "no_template")).toHaveLength(0);
    expect(rendered.sectionMapping[0]?.mapped).toBe(true);
  });

  it("appends a section the template has no slot for and REPORTS it", async () => {
    const { bytes, template } = await docxTemplate([sectionToken(1), FIXED_PLACEHOLDERS.body]);

    const rendered = await renderDocx({ model: model(), template, templateBytes: bytes });

    const appended = rendered.warnings.filter((w) => w.code === "section_appended");
    expect(appended.length).toBeGreaterThan(0);
    // The appended sections are reported by title, not silently dropped.
    expect(appended.every((w) => typeof w.params.section === "string" && w.params.section.length > 0)).toBe(true);
    const unmapped = rendered.sectionMapping.filter((row) => !row.mapped);
    expect(unmapped.length).toBe(appended.length);
  });

  it("refuses when sections have nowhere to go rather than dropping them", async () => {
    // A template with one section slot and NO body slot: sections 2..n would
    // vanish, and the document would look complete.
    const { bytes, template } = await docxTemplate([sectionToken(1)]);

    await expect(renderDocx({ model: model(), template, templateBytes: bytes })).rejects.toThrow(PublishRenderError);
  });

  it("ANTET GARANTİSİ: header/footer, gömülü logo (media) ve stiller patch'ten AYNEN çıkar", async () => {
    // The guarantee the bank relies on (M103r): renderDocx PATCHES the uploaded
    // file — it never rebuilds it — so the letterhead (header/footer), the logo
    // bytes under word/media/ and the corporate styles travel into every
    // generated analysis document untouched, while the {{...}} slots are filled.
    const { bytes, template, logo } = await brandedDocxTemplate([
      FIXED_PLACEHOLDERS.title,
      FIXED_PLACEHOLDERS.ticket,
      sectionToken(1),
      FIXED_PLACEHOLDERS.body,
    ]);

    // The fixture really is a branded .docx: header + footer parts, media, style.
    const inputEntries = await unzip(bytes);
    const headerName = [...inputEntries.keys()].find((n) => /^word\/header\d+\.xml$/.test(n));
    const footerName = [...inputEntries.keys()].find((n) => /^word\/footer\d+\.xml$/.test(n));
    const mediaName = [...inputEntries.keys()].find((n) => /^word\/media\/.+\.png$/.test(n));
    expect(headerName).toBeDefined();
    expect(footerName).toBeDefined();
    expect(mediaName).toBeDefined();

    const rendered = await renderDocx({ model: model(), template, templateBytes: bytes });
    const out = await unzip(rendered.bytes);

    // 1) The letterhead survived: the SAME header/footer parts exist and still
    //    carry the bank's text and the logo reference (a:blip → the media part).
    const headerXml = new TextDecoder().decode(out.get(headerName!));
    expect(headerXml).toContain("KURUMSAL ANTET — Banka A.Ş.");
    expect(headerXml).toContain("<a:blip"); // the logo is still referenced
    const footerXml = new TextDecoder().decode(out.get(footerName!));
    expect(footerXml).toContain("KURUMSAL ALTBILGI — gizlilik notu");

    // 2) The LOGO bytes are byte-identical — never re-encoded, never dropped.
    expect(out.has(mediaName!)).toBe(true);
    expect(Buffer.from(out.get(mediaName!)!).equals(Buffer.from(logo))).toBe(true);
    // …and the input media part came through byte-identical too (sanity).
    expect(Buffer.from(inputEntries.get(mediaName!)!).equals(Buffer.from(logo))).toBe(true);

    // 3) The corporate styles survived (`keepOriginalStyles`).
    const stylesXml = new TextDecoder().decode(out.get("word/styles.xml"));
    expect(stylesXml).toContain("KurumsalGovde");

    // 4) The body slots were FILLED: placeholders consumed, analysis in, the
    //    template's own body text intact around them.
    const xml = new TextDecoder().decode(out.get("word/document.xml"));
    expect(xml).not.toContain("{{baslik}}");
    expect(xml).not.toContain("{{ticket}}");
    expect(xml).not.toContain("{{bolum:1}}");
    expect(xml).not.toContain("{{govde}}");
    expect(xml).toContain("UGURPAY-123"); // {{ticket}} value landed
    expect(xml).toContain("Kart limit"); // section 1's analysis content landed
    expect(xml).toContain("KURUMSAL USTBILGI");
    expect(xml).toContain("KURUMSAL KAPANIS");
    expect(rendered.warnings.filter((w) => w.code === "no_template")).toHaveLength(0);
    expect(rendered.warnings.filter((w) => w.code === "template_unreadable")).toHaveLength(0);
  });

  it("falls back with a warning when the uploaded template is not a .docx", async () => {
    const template: DocTemplateFile = {
      fileName: "bozuk.docx",
      version: 3,
      uploadedAt: "2026-08-01T00:00:00.000Z",
      uploadedBy: "doc.owner@corp",
      sizeBytes: 4,
      styles: [],
      placeholders: [{ token: sectionToken(1), descriptionKey: "k", location: "", found: true }],
    };

    const rendered = await renderDocx({
      model: model(),
      template,
      templateBytes: new Uint8Array([1, 2, 3, 4]),
    });

    expect(rendered.warnings.some((w) => w.code === "template_unreadable")).toBe(true);
    expect(Array.from(rendered.bytes.slice(0, 2))).toEqual([0x50, 0x4b]);
  });
});

describe("pdf rendering (M103r)", () => {
  it("produces a real PDF with a %PDF header and an EOF marker", async () => {
    const bytes = await renderPdf(model());

    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    expect(new TextDecoder("latin1").decode(bytes.slice(-2048))).toContain("%%EOF");
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });

  it("embeds a Unicode font so Turkish characters are not corrupted", async () => {
    const bytes = await renderPdf(model());
    const raw = new TextDecoder("latin1").decode(bytes);

    // A pdfkit standard font would be `/Helvetica` with WinAnsi encoding, which
    // renders "İ" as "1" and "ş" as "_" — silently.
    expect(raw).toContain("DejaVuSans");
    expect(raw).not.toContain("/BaseFont /Helvetica");
  });
});

describe("BinaryDocPublisher (M103r)", () => {
  it("stores the file and receipts its storage key", async () => {
    const { publisher: pub, stored } = publisher("pdf");

    const receipt = await pub.publish({ ...REQ, targets: ["pdf"] }, ANALYSIS_MARKDOWN);

    expect(receipt.target).toBe("pdf");
    expect(receipt.ref).toBe(`evidence/${TICKET}/${RUN_ID}/${TICKET}-analysis.pdf`);
    const object = stored.get(receipt.ref);
    expect(object?.contentType).toBe("application/pdf");
    expect(object?.objectLock).toBe(true);
    expect(object?.bytes.byteLength).toBeGreaterThan(0);
  });

  it("does not rewrite an immutable object when the document is unchanged", async () => {
    // Object lock is on by default: a second identical write would burn a new
    // version of a WORM record for no change at all.
    const writes: string[] = [];
    const { publisher: pub } = publisher("pdf", {
      sink: {
        put: (key) => {
          writes.push(key);
          return Promise.resolve();
        },
      },
    });

    await pub.publish({ ...REQ, targets: ["pdf"] }, ANALYSIS_MARKDOWN);
    await pub.publish({ ...REQ, targets: ["pdf"] }, ANALYSIS_MARKDOWN);

    expect(writes).toHaveLength(1);
  });

  it("refuses a document with no renderable content", async () => {
    const { publisher: pub } = publisher("pdf");

    await expect(pub.publish({ ...REQ, targets: ["pdf"] }, "<!-- maestro:doc kind=analysis -->")).rejects.toThrow(
      PublishRenderError,
    );
  });

  it("reports template warnings to the caller rather than swallowing them", async () => {
    const seen: string[] = [];
    const { publisher: pub } = publisher("docx", {
      onWarnings: (warnings) => seen.push(...warnings.map((w) => w.code)),
    });

    await pub.publish(REQ, ANALYSIS_MARKDOWN);

    expect(seen).toContain("no_template");
  });
});
