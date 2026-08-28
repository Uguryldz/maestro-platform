import { writeFileSync } from "node:fs";
import { Document, Packer, Paragraph, TextRun } from "docx";

/**
 * Produce a genuine corporate `.docx` for the smoke run.
 *
 * Built with the same library the platform renders documents with, so what the
 * upload endpoint receives is the kind of file a bank's document team actually
 * produces — not a hand-assembled zip that would prove only that the check can
 * be satisfied by something shaped right.
 *
 * The approval table's placeholder is left OUT on purpose: the interesting
 * proof is that the scan reports what is MISSING, and a template carrying
 * everything would demonstrate nothing.
 */
const doc = new Document({
  creator: "Uğur Bank",
  title: "Kurumsal Analiz Şablonu",
  styles: {
    default: { document: { run: { font: "Calibri", size: 22 } } },
    paragraphStyles: [
      { id: "KurumBaslik", name: "Kurum Başlık", basedOn: "Normal", run: { size: 32, bold: true } },
      { id: "KurumGovde", name: "Kurum Gövde", basedOn: "Normal", run: { size: 22 } },
    ],
  },
  sections: [
    {
      children: [
        new Paragraph({
          style: "KurumBaslik",
          children: [new TextRun({ text: "Uğur Bank — Analiz Dokümanı" })],
        }),
        new Paragraph({ children: [new TextRun({ text: "Başlık: {{baslik}}" })] }),
        new Paragraph({ children: [new TextRun({ text: "Ticket: {{ticket}}" })] }),
        new Paragraph({ children: [new TextRun({ text: "Koşu: {{kosu}}" })] }),
        new Paragraph({ children: [new TextRun({ text: "Künye: {{kunye}}" })] }),
        new Paragraph({ children: [new TextRun({ text: "Gövde: {{govde}}" })] }),
        new Paragraph({ children: [new TextRun({ text: "Bölüm 1: {{bolum:1}}" })] }),
        new Paragraph({ children: [new TextRun({ text: "Bölüm 2: {{bolum:2}}" })] }),
      ],
    },
  ],
});

const target = process.argv[2];
if (target === undefined) throw new Error("usage: make-smoke-docx.ts <path>");
writeFileSync(target, await Packer.toBuffer(doc));
console.info(`[make-smoke-docx] wrote ${target}`);
