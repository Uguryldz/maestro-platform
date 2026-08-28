import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AnalysisDoc } from "@maestro/contracts";
import { buildDocumentModel } from "../src/doc-model.js";
import { renderAnalysisMarkdown } from "../src/documents.js";
import { blockToDocx } from "../src/docx-blocks.js";
import { renderDocx } from "../src/docx-render.js";
import { renderPdf } from "../src/pdf-render.js";
import { fakeTranslate, RUN_ID, TICKET } from "./helpers.js";
import { unzip } from "./doc-helpers.js";

/**
 * What a bank reviewer actually opens (M103r).
 *
 * Every defect asserted here shipped to a live ticket and was found by a human
 * reading `OPS-66-analiz.pdf`, not by this suite — which at the time was green.
 * That is the whole reason these assertions read the RENDERED artefact: the
 * extracted PDF text and the `.docx` XML, never the model's input. A test that
 * checks "the renderer was handed the right string" is the test that let a
 * document go out with `1. 1. Amaç ve iş değeri` on every heading.
 *
 * The fixture is deliberately the ugly case: markdown in the free-text sections
 * (the model emits it whether or not the prompt asks), a blank bullet between
 * two labelled fields, and an empty clarifications section.
 */

const PDFTOTEXT = ["/usr/bin/pdftotext", "/usr/local/bin/pdftotext"].find((p) => existsSync(p));

function extract(bytes: Uint8Array, name: string): string {
  const pdf = `/tmp/${name}.pdf`;
  const txt = `/tmp/${name}.txt`;
  writeFileSync(pdf, bytes);
  execFileSync(PDFTOTEXT as string, ["-layout", pdf, txt]);
  return execFileSync("/bin/cat", [txt]).toString();
}

/**
 * The catalog ships NUMBERED section titles ("1. Amaç ve iş değeri"), which is
 * exactly the input that produced the doubled numbering. The stub reproduces
 * that rather than hiding it: the fix has to hold against the real catalog.
 */
const NUMBERED_TITLES: Record<string, string> = {
  "publish.section.purpose": "1. Amaç ve iş değeri",
  "publish.section.scope": "2. Kapsam",
  "publish.section.impact": "3. Etki analizi",
  "publish.section.acceptance": "4. Kabul kriterleri",
  "publish.section.ui_api": "5. Ekran ve API değişiklikleri",
  "publish.section.test_approach": "6. Test yaklaşımı",
  "publish.section.risk": "7. Risk ve geri dönüş planı",
  "publish.section.clarifications": "Kullanılan açıklamalar",
  "publish.meta.ticket": "Ticket",
  "publish.meta.run": "Akış",
  "publish.meta.template_version": "Şablon sürümü",
  "publish.doc.imprint_prepared_by": "Hazırlayan",
  "publish.doc.imprint_date": "Tarih",
  "publish.doc.imprint_version": "Şablon sürümü",
  "publish.doc.imprint_ticket": "Ticket",
  "publish.doc.prepared_by_maestro": "Maestro (AI) — insan onayına tabidir",
  "publish.label.scope_included": "Kapsam içi",
  "publish.label.scope_excluded": "Kapsam dışı",
  "publish.label.none": "Yok",
  "publish.label.risk": "Risk",
  "publish.label.risk_tier": "Risk katmanı",
  "publish.label.risk_reason": "Risk gerekçesi",
  "publish.label.mitigation": "Önlem",
  "publish.label.rollback": "Geri dönüş planı",
  "publish.label.impacted": "etkileniyor",
  "publish.label.not_impacted": "etkilenmiyor",
  "publish.impact_source.primary_repo_discovery": "birincil repo keşfi",
  "publish.risk_tier.orta": "Orta",
  "publish.title.analysis": "Analiz Dokümanı — {ticket}",
};

function catalogTranslate(_locale: string, key: string, params?: Record<string, string>): string {
  let value = NUMBERED_TITLES[key] ?? `tr:${key}`;
  for (const [name, replacement] of Object.entries(params ?? {})) {
    value = value.replaceAll(`{${name}}`, replacement);
  }
  return value;
}

const ANALYSIS: AnalysisDoc = {
  templateVersion: "analysis-template@1.4.0",
  language: "tr",
  purpose: "Mobil ve web uygulamalarında limit aşımı uyarısı göstermek.",
  scope: { included: ["Limit servisi", "Mobil ekran"], excluded: [] },
  impactMatrix: [
    { appId: "ugurpay", impacted: true, summary: "Limit servisi değişiyor", source: "primary_repo_discovery" },
  ],
  acceptanceCriteria: ["Buton üstte görünür.", "İndirme denetime yazılır."],
  // Markdown, as the model really writes it: a bold lead-in, `- ` bullets, a
  // nested `  - `, and a `* ` variant.
  uiApiChanges: [
    "**UI Değişiklikleri:**",
    "- Mobil ve web uygulamalarında limit göstergesi eklenecek.",
    "- Limit aşımı durumunda uyarı gösterilecek.",
    "  - Uyarı metni yerelleştirilecek.",
    "",
    "**API Değişiklikleri:**",
    "* POST /limits/increase ucu eklenir.",
  ].join("\n"),
  // A BLANK bullet in the middle — legal markdown, and the source of the bare
  // `•` that shipped.
  testApproach: ["**Test Kapsamı:**", "- Birim testleri", "- ", "- Entegrasyon testleri"].join("\n"),
  riskAndRollback: {
    risk: "Limit hesabı yanlış olabilir",
    mitigation: "Çift kontrol ve kanarya yayın",
    rollback: "Feature flag kapatılır",
  },
  riskTier: "orta",
  riskReason: "Finansal limit değişikliği",
  // Empty: section 8 must not be printed at all.
  clarificationsUsed: [],
};

function documentModel() {
  const markdown = renderAnalysisMarkdown(ANALYSIS, {
    translate: catalogTranslate,
    locale: "tr",
    runId: RUN_ID,
    ticketKey: TICKET,
  });
  return buildDocumentModel({
    markdownSource: markdown,
    translate: catalogTranslate,
    locale: "tr",
    ticketKey: TICKET,
    runId: RUN_ID,
    templateVersion: "analysis-template@1.4.0",
    date: "2026-08-16",
  });
}

async function docxText(): Promise<string> {
  const rendered = await renderDocx({ model: documentModel(), template: null, templateBytes: null });
  const entries = await unzip(rendered.bytes);
  return new TextDecoder().decode(entries.get("word/document.xml"));
}

describe("the künye a reviewer reads (M103r)", () => {
  it("states each fact exactly once and never twice", () => {
    const labels = documentModel().imprint.rows.map(([key]) => key);

    // "Ticket / Ticket / Akış / Şablon sürümü" was the shipped order: the four
    // fixed rows, then the SAME facts again from the markdown metadata bullets.
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of ["Ticket", "Şablon sürümü", "Hazırlayan", "Tarih"]) {
      expect(labels.filter((l) => l === label)).toHaveLength(1);
    }
  });

  it("does not print the internal workflow id to a business reader", () => {
    const model = documentModel();

    // `Akış: maestro-OPS-66` is a Temporal handle. It stays in the `maestro:doc`
    // marker for the audit trail and off the reviewer's first page.
    expect(model.imprint.rows.map(([key]) => key)).not.toContain("Akış");
    expect(model.imprint.rows.some(([, value]) => value.includes(RUN_ID))).toBe(false);
  });

  it("carries what a bank reviewer needs to identify the document", () => {
    const rows = new Map(documentModel().imprint.rows);

    expect(rows.get("Ticket")).toBe(TICKET);
    expect(rows.get("Tarih")).toBe("2026-08-16");
    expect(rows.get("Şablon sürümü")).toBe("analysis-template@1.4.0");
    expect(rows.get("Hazırlayan")).toContain("insan onayına tabidir");
  });
});

describe("section numbering has ONE source (M103r)", () => {
  it("numbers from the model and strips the number the catalog title carries", () => {
    const sections = documentModel().sections;

    // The catalog says "1. Amaç ve iş değeri"; the renderer prefixes "1. ".
    // Whichever layer keeps it, exactly one of them may.
    expect(sections.map((s) => s.title)).toEqual([
      "Amaç ve iş değeri",
      "Kapsam",
      "Etki analizi",
      "Kabul kriterleri",
      "Ekran ve API değişiklikleri",
      "Test yaklaşımı",
      "Risk ve geri dönüş planı",
    ]);
    expect(sections.map((s) => s.number)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
  });

  it("keeps a digit that is part of a real title", () => {
    const model = buildDocumentModel({
      markdownSource: "# Baslik\n\n## 3D Secure akışı\n\nMetin.\n",
      translate: fakeTranslate(),
      locale: "tr",
      ticketKey: TICKET,
      runId: RUN_ID,
      templateVersion: "t@1",
      date: "2026-08-16",
    });

    expect(model.sections[0]?.title).toBe("3D Secure akışı");
  });

  it("renders no doubled number anywhere in the .docx", async () => {
    const xml = await docxText();

    // "1. 1. Amaç", "7. 7. Risk" — the literal defect, in the bytes.
    expect(xml).not.toMatch(/>(\d+)\.\s*\1\./);
  });
});

describe("markdown the model wrote becomes real formatting (M103r)", () => {
  it("turns **bold** into a bold run instead of printing the asterisks", async () => {
    const xml = await docxText();

    expect(xml).not.toContain("**");
    expect(xml).toContain("UI Değişiklikleri:");
    // The label is a real bold run, which is what `**` was asking for.
    expect(xml).toMatch(/<w:b\/>[\s\S]{0,120}UI Değişiklikleri:/);
  });

  it("turns `- ` and `* ` items into list paragraphs, not one run-together line", async () => {
    const xml = await docxText();

    // The shipped defect was ONE paragraph reading
    // "**UI Değişiklikleri:** - Mobil ... - Limit ...".
    expect(xml).not.toMatch(/Mobil ve web uygulamalarında[^<]*Limit aşımı/);
    for (const item of [
      "Mobil ve web uygulamalarında limit göstergesi eklenecek.",
      "Limit aşımı durumunda uyarı gösterilecek.",
      "Uyarı metni yerelleştirilecek.",
      "POST /limits/increase ucu eklenir.",
    ]) {
      expect(xml).toContain(item);
    }
    // Every one of them is a list paragraph rather than prose.
    const listItems = xml.split("<w:p>").filter((p) => p.includes("ListParagraph"));
    expect(listItems.length).toBeGreaterThanOrEqual(4);
  });

  it("drops a blank list item instead of drawing a bullet with no text", async () => {
    const xml = await docxText();

    // `- ` between two real items: three source lines, two rendered bullets.
    // The two real ones must genuinely BE bullets — the blank one is what gets
    // dropped, not the section's list-ness.
    const bullets = xml.split("<w:p>").filter((p) => p.includes("ListParagraph"));
    const empty = bullets.filter((p) => !/<w:t[^>]*>[^<]/.test(p));
    expect(empty).toHaveLength(0);
    expect(bullets.filter((p) => p.includes("Birim testleri"))).toHaveLength(1);
    expect(bullets.filter((p) => p.includes("Entegrasyon testleri"))).toHaveLength(1);
  });

  it("drops a blank item the parser hands the renderer directly", () => {
    // Defense in depth: even if a caller builds the model from markdown that
    // already carries `- `, neither renderer may draw a naked bullet.
    const model = buildDocumentModel({
      markdownSource: "# B\n\n## Kapsam\n\n- ilk\n- \n- son\n",
      translate: fakeTranslate(),
      locale: "tr",
      ticketKey: TICKET,
      runId: RUN_ID,
      templateVersion: "t@1",
      date: "2026-08-16",
    });
    const list = model.sections[0]?.blocks.find((b) => b.kind === "list");

    // The parser still reports the blank item; the RENDERER is what drops it.
    expect(list?.kind === "list" && list.items).toHaveLength(3);
    const paragraphs = blockToDocx(list!);
    expect(paragraphs).toHaveLength(2);
  });
});

describe("sections that say nothing are not printed (M103r)", () => {
  it("omits a section whose only content is 'Yok'", async () => {
    const model = documentModel();

    // "8. Kullanılan açıklamalar" + a single bullet reading "Yok" took a heading
    // and part of a page to say there was nothing to say.
    expect(model.sections.map((s) => s.title)).not.toContain("Kullanılan açıklamalar");
    expect(await docxText()).not.toContain("Kullanılan açıklamalar");
  });

  it("keeps a section that says 'Yok' among real content", () => {
    const model = buildDocumentModel({
      markdownSource: "# B\n\n## Kapsam\n\n- Yok\n- Gerçek bir madde\n",
      translate: fakeTranslate(),
      locale: "tr",
      ticketKey: TICKET,
      runId: RUN_ID,
      templateVersion: "t@1",
      date: "2026-08-16",
    });

    // "Yok" alongside a claim is itself a claim about scope.
    expect(model.sections.map((s) => s.title)).toContain("Kapsam");
  });

  it("renumbers contiguously after a section is dropped", () => {
    const numbers = documentModel().sections.map((s) => s.number);

    // Dropping section 8 must not leave a gap, and must not renumber 1..7.
    expect(numbers).toEqual(numbers.map((_, i) => String(i + 1)));
  });
});

describe("the risk section reads as a statement, not a record dump (M103r)", () => {
  it("states tier and justification as one sentence", () => {
    const risk = documentModel().sections.find((s) => s.title === "Risk ve geri dönüş planı");
    const text = JSON.stringify(risk?.blocks);

    // Shipped as two of five `Label: value` bullets — "Risk katmanı: Orta",
    // "Risk gerekçesi: …" — which reads like debug output at a human gate.
    expect(text).toContain("Risk katmanı: Orta — Finansal limit değişikliği");
    expect(text).not.toContain("Risk gerekçesi:");
    // The three parallel facts a reviewer compares stay a labelled list.
    for (const label of ["Risk", "Önlem", "Geri dönüş planı"]) {
      expect(text).toContain(label);
    }
  });
});

describe.skipIf(PDFTOTEXT === undefined)("no bullet is stranded at a page break (M103r)", () => {
  /**
   * The OPS-72 shape, reduced.
   *
   * A run of long wrapping bullets is the only way to land a marker exactly at
   * a page edge, which is what produced two bare `•` glyphs in a real ticket's
   * PDF — one above the page-1 footer whose text resumed on page 2, one above
   * the page-2 footer whose "Geri dönüş planı: …" resumed on page 3. Neither was
   * an empty list item: the data was fine and the LAYOUT split the item from its
   * own marker. The sweep is over many item lengths because which item lands on
   * the boundary depends entirely on how the ones before it wrapped.
   */
  function longListMarkdown(sentenceCount: number): string {
    const sentence =
      "Ekstre üretim süresi mevcut performans standartlarını korumalıdır ve taksit " +
      "bilgisi tutarlı biçimde gösterilmelidir";
    const items = Array.from(
      { length: 14 },
      (_, i) => `- ${Array.from({ length: sentenceCount }, () => sentence).join(". ")} (${String(i + 1)})`,
    );
    return `# Analiz\n\n## Kabul kriterleri\n\n${items.join("\n")}\n`;
  }

  it("never draws a marker on a page whose text begins on the next one", async () => {
    // Several lengths, so a marker lands on the boundary in at least some of
    // them; the invariant must hold in every one.
    for (const sentenceCount of [1, 2, 3, 4, 5]) {
      const built = buildDocumentModel({
        markdownSource: longListMarkdown(sentenceCount),
        translate: fakeTranslate(),
        locale: "tr",
        ticketKey: TICKET,
        runId: RUN_ID,
        templateVersion: "t@1",
        date: "2026-08-16",
      });
      const text = extract(await renderPdf(built), `maestro-orphan-${String(sentenceCount)}`);

      // A page whose last content line is a lone bullet glyph is the defect:
      // the reader sees "•" and has to turn the page to find its sentence.
      for (const [index, page] of text.split("\f").entries()) {
        const contentLines = page
          .split("\n")
          .map((line) => line.trimEnd())
          .filter((line) => line.trim().length > 0)
          // The footer ("OPS-72   1/3") is furniture, not content.
          .filter((line) => !/\d+\s*\/\s*\d+\s*$/.test(line));
        const last = contentLines[contentLines.length - 1] ?? "";
        expect(
          last.replace(/[•\s]/g, "").length === 0 && last.includes("•"),
          `sentenceCount=${String(sentenceCount)} page ${String(index + 1)} ends with a stranded bullet: ${JSON.stringify(last)}`,
        ).toBe(false);
      }
    }
  }, 30000);
});

describe.skipIf(PDFTOTEXT === undefined)("the same document, read back out of the PDF", () => {
  it("shows no doubled numbers, no asterisks and no empty bullet", async () => {
    const text = extract(await renderPdf(documentModel()), "maestro-legibility");

    expect(text).not.toMatch(/(\d+)\.\s+\1\./); // "1. 1. Amaç"
    expect(text).not.toContain("**"); // raw markdown
    expect(text).toContain("1. Amaç ve iş değeri");
    expect(text).toContain("7. Risk ve geri dönüş planı");
    expect(text).not.toContain("Kullanılan açıklamalar"); // the empty section

    // Every bullet the reader sees has text beside it.
    const bulletLines = text.split("\n").filter((line) => line.includes("•"));
    expect(bulletLines.length).toBeGreaterThan(0);
    for (const line of bulletLines) {
      expect(line.replace(/[•\s]/g, "").length).toBeGreaterThan(0);
    }
  });

  it("prints each künye label exactly once", async () => {
    const text = extract(await renderPdf(documentModel()), "maestro-legibility-kunye");
    const header = text.slice(0, text.indexOf("1. Amaç"));

    for (const label of ["Ticket", "Şablon sürümü", "Hazırlayan", "Tarih"]) {
      expect(header.split(label).length - 1).toBe(1);
    }
    expect(header).not.toContain("Akış");
  });
});
