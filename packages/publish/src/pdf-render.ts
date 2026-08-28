import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import PDFDocument from "pdfkit";
import type { DocumentModel } from "./doc-model.js";
import { plainText } from "./doc-model.js";
import { PublishRenderError } from "./errors.js";
import type { Block, Inline } from "./parse.js";
import { safeHref } from "./parse.js";

/**
 * `.pdf` generation (M103r), from the SAME document model the `.docx` driver
 * renders. Not a conversion of the `.docx`: converting Word to PDF needs
 * LibreOffice or Word itself, and a container that must grow a 400 MB office
 * suite to publish a document is an operational surprise nobody signed up for.
 * Two renderers over one model is the cheaper honesty.
 *
 * The consequence is stated rather than hidden: the PDF carries the analysis
 * with corporate typography, but it does NOT reproduce a bank template's cover
 * artwork or logo — those live inside the uploaded `.docx`. The `.docx` is the
 * template-faithful artefact; the PDF is the portable one.
 */

const NAVY = "#1F3864";
const GREY = "#F2F2F2";
const MARGIN = 56;

/**
 * Turkish is not optional here.
 *
 * pdfkit's built-in Helvetica is WinAnsi-encoded: `İ` renders as `1`, `ı` and
 * `ğ` as `á`, `ş` as `_`. That is silent corruption of a Turkish bank's
 * approved document — the file opens, looks plausible and says something else.
 * A Unicode TTF is therefore EMBEDDED, and it ships as an npm dependency
 * rather than being read from `/usr/share/fonts`, because a font that happens
 * to exist on this container is exactly the kind of assumption that breaks in
 * the bank's own image.
 */
const require = createRequire(import.meta.url);

function fontPath(file: string): string {
  // The `dejavu-fonts-ttf` package restricts deep imports via its `exports`
  // field, so `require.resolve("dejavu-fonts-ttf/ttf/X.ttf")` throws under
  // modern Node resolution — which previously produced a SILENT empty PDF
  // when the caller (e.g. the pilot) swallowed the error path. Resolve the
  // package ROOT (always allowed) and build the ttf path from there.
  try {
    const pkgJson = require.resolve("dejavu-fonts-ttf/package.json");
    const ttf = join(dirname(pkgJson), "ttf", file);
    if (!existsSync(ttf)) {
      throw new Error(`ttf missing at ${ttf}`);
    }
    return ttf;
  } catch (cause) {
    throw new PublishRenderError(
      `the PDF font ${file} could not be resolved (${String(cause)}) — Turkish characters ` +
        `would be corrupted silently, refusing to render`,
    );
  }
}

const FONTS = {
  body: () => fontPath("DejaVuSans.ttf"),
  bold: () => fontPath("DejaVuSans-Bold.ttf"),
  mono: () => fontPath("DejaVuSansMono.ttf"),
};

type Doc = InstanceType<typeof PDFDocument>;

export async function renderPdf(model: DocumentModel): Promise<Uint8Array> {
  const doc = new PDFDocument({ size: "A4", margin: MARGIN, autoFirstPage: true, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    doc.on("end", () => resolve());
    doc.on("error", (error: Error) => reject(error));
  });

  doc.registerFont("body", FONTS.body());
  doc.registerFont("bold", FONTS.bold());
  doc.registerFont("mono", FONTS.mono());

  writeTitle(doc, model.title);
  writeImprint(doc, model.imprint.rows);
  for (const block of model.preamble) writeBlock(doc, block);
  for (const section of model.sections) {
    writeHeading(doc, `${section.number}. ${section.title}`, 15);
    for (const block of section.blocks) writeBlock(doc, block);
  }
  paginate(doc, model.imprint.ticket);

  doc.end();
  await done;
  const bytes = Buffer.concat(chunks);
  if (bytes.byteLength === 0) throw new PublishRenderError("the PDF renderer produced no bytes");
  return new Uint8Array(bytes);
}

function writeTitle(doc: Doc, title: string): void {
  doc.font("bold").fontSize(20).fillColor(NAVY).text(title, { align: "left" });
  const y = doc.y + 4;
  doc.moveTo(MARGIN, y).lineTo(doc.page.width - MARGIN, y).lineWidth(1.5).strokeColor(NAVY).stroke();
  doc.moveDown(1).fillColor("black");
}

/** The künye, as a two-column shaded table under the title. */
function writeImprint(doc: Doc, rows: readonly (readonly [string, string])[]): void {
  const width = doc.page.width - MARGIN * 2;
  const keyWidth = width * 0.3;
  for (const [key, value] of rows) {
    const height = Math.max(
      doc.font("bold").fontSize(10).heightOfString(key, { width: keyWidth - 12 }),
      doc.font("body").fontSize(10).heightOfString(value, { width: width - keyWidth - 12 }),
    ) + 10;
    ensureRoom(doc, height);
    const top = doc.y;
    doc.rect(MARGIN, top, keyWidth, height).fill(GREY);
    doc.rect(MARGIN, top, width, height).lineWidth(0.5).strokeColor("#CCCCCC").stroke();
    doc.fillColor("black").font("bold").fontSize(10).text(key, MARGIN + 6, top + 5, { width: keyWidth - 12 });
    doc.font("body").fontSize(10).text(value, MARGIN + keyWidth + 6, top + 5, { width: width - keyWidth - 12 });
    doc.y = top + height;
  }
  doc.moveDown(1);
}

function writeHeading(doc: Doc, text: string, size: number): void {
  ensureRoom(doc, size * 2.2);
  doc.moveDown(0.6);
  doc.font("bold").fontSize(size).fillColor(NAVY).text(text, MARGIN, doc.y, { width: contentWidth(doc) });
  doc.fillColor("black").moveDown(0.3);
}

function writeBlock(doc: Doc, block: Block): void {
  switch (block.kind) {
    case "heading":
      writeHeading(doc, plainText(block.inline), block.level >= 3 ? 11 : 13);
      return;
    case "paragraph":
      writeRuns(doc, block.inline, MARGIN, contentWidth(doc));
      doc.moveDown(0.5);
      return;
    case "list": {
      // Blank items are dropped, not bulleted — see `blockToDocx`. A lone `•`
      // with no text beside it is what a reviewer reads as a lost sentence.
      const items = block.items.filter((item) => plainText(item).trim().length > 0);
      items.forEach((item, index) => {
        const marker = block.ordered ? `${String(index + 1)}.` : "•";
        // The marker and the item's FIRST LINE are placed together or not at
        // all. Reserving only the marker's own 16pt used to let the glyph fit at
        // the bottom of a page while the text — measured at its full wrapped
        // height inside `writeRuns` — did not, so `writeRuns` opened a new page
        // and left the bullet stranded on the previous one. A real OPS-72 render
        // did this twice: a `•` alone above the page-1 footer, and another above
        // the page-2 footer whose "Geri dönüş planı: …" text began on page 3.
        // Both read as a sentence that went missing at a human gate.
        //
        // Only the first line is required to fit, not the whole item: a five-line
        // risk statement that cannot fit anywhere would otherwise be pushed to a
        // fresh page for nothing, or loop forever on a page that is never big
        // enough. Widow control, deliberately not orphan control.
        keepWithFirstLine(doc, contentWidth(doc) - 26);
        const top = doc.y;
        doc.font("body").fontSize(10.5).fillColor("black").text(marker, MARGIN + 6, top, { width: 16 });
        doc.y = top;
        writeRuns(doc, item, MARGIN + 26, contentWidth(doc) - 26, true);
      });
      doc.moveDown(0.5);
      return;
    }
    case "code": {
      const lines = block.text.split(/\r\n?|\n/);
      const height = lines.length * 12 + 10;
      ensureRoom(doc, Math.min(height, 200));
      const top = doc.y;
      doc.rect(MARGIN, top, contentWidth(doc), height).fill(GREY);
      doc.fillColor("black").font("mono").fontSize(9);
      doc.text(block.text, MARGIN + 6, top + 5, { width: contentWidth(doc) - 12 });
      doc.y = Math.max(doc.y, top + height) + 6;
      return;
    }
  }
}

/**
 * Break the page BEFORE a bullet whose first line would not fit beside it.
 *
 * `ensureRoom` is called with ONE line's height rather than the whole item's,
 * which is what keeps this from being orphan control: an item taller than a
 * page must still be allowed to start where it is and flow over, otherwise it
 * could never be placed at all. What is guaranteed is only that a marker is
 * never drawn on a page that has no room for the text it introduces.
 */
function keepWithFirstLine(doc: Doc, width: number): void {
  doc.font("body").fontSize(10.5);
  // pdfkit has no "height of the first line" call; a one-line measurement of a
  // non-empty string is the line height, and `currentLineHeight` agrees.
  ensureRoom(doc, doc.heightOfString("X", { width }));
}

/**
 * Inline runs as one flowing line, honouring bold/code/link.
 *
 * pdfkit's `continued: true` chain does NOT leave `doc.y` after the wrapped
 * text — it leaves it where the last fragment started. Trusting it drew the
 * second bullet on top of the first ("Mobil artırım / Limit ekran servisi" in a
 * real render), which is unreadable and, in an approved analysis, wrong. So the
 * height is measured up front and `doc.y` is set explicitly afterwards.
 *
 * `anchored` says a caller has ALREADY committed ink at this position — the
 * bullet glyph — so the text may not start by turning the page. Without it the
 * full-height `ensureRoom` below broke the page after the marker was drawn and
 * stranded it: two bare `•` glyphs in the OPS-72 PDF, each with its sentence on
 * the following page. An anchored run flows past the bottom margin instead,
 * which pdfkit continues onto the next page as normal wrapping — the item stays
 * attached to its marker.
 */
function writeRuns(doc: Doc, inline: readonly Inline[], x: number, width: number, anchored = false): void {
  const text = inline.map((run) => (run.kind === "link" ? linkText(run) : run.text)).join("");
  if (text.length === 0) return;
  doc.font("body").fontSize(10.5);
  const height = doc.heightOfString(text, { width });
  if (!anchored) ensureRoom(doc, height);

  const start = doc.y;
  doc.fillColor("black");
  let first = true;
  for (const run of inline) {
    const fragment = run.kind === "link" ? linkText(run) : run.text;
    if (fragment.length === 0) continue;
    doc.font(run.kind === "strong" ? "bold" : run.kind === "code" ? "mono" : "body");
    doc.text(fragment, first ? x : undefined, first ? start : undefined, {
      width,
      continued: true,
      align: "left",
    });
    first = false;
  }
  // Close the chain, then place the cursor where the text actually ended.
  doc.text("", { continued: false });
  doc.x = MARGIN;
  doc.y = start + height;
}

function linkText(run: Extract<Inline, { kind: "link" }>): string {
  const href = safeHref(run.href);
  return href === null ? run.text : `${run.text} (${href})`;
}

function contentWidth(doc: Doc): number {
  return doc.page.width - MARGIN * 2;
}

/** Start a new page when the next element would not fit. */
function ensureRoom(doc: Doc, height: number): void {
  if (doc.y + height > doc.page.height - MARGIN) doc.addPage();
}

/**
 * Page numbers, written after the fact over the buffered pages. `bufferPages`
 * is what makes "N / total" possible: the total is not known until the content
 * has been laid out.
 */
function paginate(doc: Doc, ticket: string): void {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(range.start + i);
    // The footer sits INSIDE the bottom margin band. Writing at
    // `height - MARGIN + 12` put it BELOW the page body, and pdfkit reacts to
    // text past the bottom margin by spawning a fresh page — which is what
    // produced a trail of empty pages after the real content. Keep it above
    // the bottom edge and disable page-wrapping for the footer text.
    const y = doc.page.height - MARGIN + 6;
    doc.font("body").fontSize(8).fillColor("#666666");
    const half = contentWidth(doc) / 2;
    doc.text(ticket, MARGIN, y, { width: half, lineBreak: false, height: 12 });
    doc.text(`${String(i + 1)} / ${String(range.count)}`, MARGIN + half, y, {
      width: half,
      align: "right",
      lineBreak: false,
      height: 12,
    });
  }
  doc.flushPages();
}
