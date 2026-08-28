import {
  AlignmentType,
  BorderStyle,
  HeadingLevel,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ParagraphChild,
} from "docx";
import { plainText, type DocSection, type DocumentModel, type Imprint } from "./doc-model.js";
import type { Block, Inline } from "./parse.js";
import { safeHref } from "./parse.js";

/**
 * Markdown blocks → `docx` objects (M103r).
 *
 * Kept apart from the driver so the mapping is unit-testable without a zip, and
 * so the driver file stays about ORCHESTRATION (template, placeholders,
 * warnings) rather than about typography.
 *
 * Style ids (`MaestroHeading1`, …) are referenced by name so an uploaded
 * corporate template that defines them wins: the bank's own fonts and colours
 * are the point of M103r. `docx-styles.ts` supplies fallbacks for the
 * no-template path.
 */

/** Corporate navy of the reference document's table header row. */
export const TABLE_HEADER_FILL = "1F3864";
const CODE_FILL = "F2F2F2";

export function inlineRuns(inline: readonly Inline[], base?: { bold?: boolean }): ParagraphChild[] {
  const runs: ParagraphChild[] = [];
  for (const run of inline) {
    switch (run.kind) {
      case "strong":
        runs.push(new TextRun({ text: run.text, bold: true }));
        break;
      case "code":
        runs.push(new TextRun({ text: run.text, font: "DejaVu Sans Mono", shading: { type: ShadingType.CLEAR, fill: CODE_FILL } }));
        break;
      case "link": {
        // A link target that is not http(s)/mailto degrades to plain text —
        // the same rule the ADF and storage-format renderers apply. A `.docx`
        // is opened by a human on a bank desktop; a `javascript:` or `file:`
        // hyperlink in an approved document is not a decoration.
        const href = safeHref(run.href);
        runs.push(
          href === null
            ? new TextRun({ text: run.text, bold: base?.bold })
            : new TextRun({ text: `${run.text} (${href})`, style: "Hyperlink" }),
        );
        break;
      }
      default:
        runs.push(new TextRun({ text: run.text, bold: base?.bold }));
    }
  }
  return runs.length > 0 ? runs : [new TextRun("")];
}

/** One markdown block → zero or more `docx` children. */
export function blockToDocx(block: Block): (Paragraph | Table)[] {
  switch (block.kind) {
    case "heading": {
      // Section headings are emitted by `sectionToDocx`; a heading INSIDE a
      // section is a sub-heading and keeps its relative level.
      const level = block.level >= 3 ? HeadingLevel.HEADING_3 : HeadingLevel.HEADING_2;
      return [new Paragraph({ heading: level, children: inlineRuns(block.inline) })];
    }
    case "paragraph":
      return [new Paragraph({ children: inlineRuns(block.inline), spacing: { after: 120 } })];
    case "list":
      // A blank item is dropped rather than bulleted. `- ` with nothing after it
      // is legal markdown and a model emits it between two labelled fields; it
      // reached the reference PDF as a bare `•` sitting alone before a page
      // break, which reads as content that went missing.
      return block.items
        .filter((item) => plainText(item).trim().length > 0)
        .map(
          (item) =>
            new Paragraph({
              children: inlineRuns(item),
              bullet: block.ordered ? undefined : { level: 0 },
              numbering: block.ordered ? { reference: "maestro-ordered", level: 0 } : undefined,
            }),
        );
    case "code":
      return codeParagraphs(block.text);
  }
}

/**
 * Code fences become monospaced, shaded lines. One paragraph per LINE: a code
 * block is not prose, and letting Word reflow a config snippet across the page
 * width is how an approved document ends up describing a setting nobody typed.
 */
function codeParagraphs(text: string): Paragraph[] {
  const lines = text.split(/\r\n?|\n/);
  return lines.map(
    (line, index) =>
      new Paragraph({
        children: [new TextRun({ text: line === "" ? " " : line, font: "DejaVu Sans Mono", size: 18 })],
        shading: { type: ShadingType.CLEAR, fill: CODE_FILL },
        spacing: { before: index === 0 ? 120 : 0, after: index === lines.length - 1 ? 120 : 0 },
      }),
  );
}

/** The künye: a two-column identity table, as in the reference document. */
export function imprintTable(imprint: Imprint): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: imprint.rows.map(
      ([key, value]) =>
        new TableRow({
          children: [
            new TableCell({
              width: { size: 30, type: WidthType.PERCENTAGE },
              shading: { type: ShadingType.CLEAR, fill: "F2F2F2" },
              children: [new Paragraph({ children: [new TextRun({ text: key, bold: true })] })],
            }),
            new TableCell({ children: [new Paragraph({ children: [new TextRun(value)] })] }),
          ],
        }),
    ),
  });
}

/**
 * A section, numbered as the standard requires: `1. Amaç`, `2. Kapsam`, …
 * The number is part of the heading TEXT rather than a Word list field, so the
 * numbering survives a copy-paste into Jira or an email — auditors do that.
 */
export function sectionToDocx(section: DocSection): (Paragraph | Table)[] {
  const heading = new Paragraph({
    heading: HeadingLevel.HEADING_1,
    children: [new TextRun({ text: `${section.number}. ${section.title}`, bold: true })],
    spacing: { before: 240, after: 120 },
  });
  return [heading, ...section.blocks.flatMap(blockToDocx)];
}

/** Title + künye + every section, in order. The whole body of the document. */
export function modelToDocx(model: DocumentModel): (Paragraph | Table)[] {
  return [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.LEFT,
      children: [new TextRun({ text: model.title, bold: true })],
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: TABLE_HEADER_FILL, space: 4 } },
      spacing: { after: 200 },
    }),
    imprintTable(model.imprint),
    new Paragraph({ text: "", spacing: { after: 200 } }),
    ...model.preamble.flatMap(blockToDocx),
    ...model.sections.flatMap(sectionToDocx),
  ];
}
