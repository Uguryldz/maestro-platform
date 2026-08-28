import { inflateRawSync } from "node:zlib";
import { t } from "@maestro/config";
import type { AnalysisDoc } from "@maestro/contracts";
import { stripLeadingNumber } from "@maestro/publish";
import { describe, expect, it } from "vitest";
import {
  DOC_CONTENT_TYPE,
  DocStore,
  type AttachCapableWork,
  analysisToDocModel,
  analysisToDocs,
  attachAnalysisDocs,
  docFileName,
  type GeneratedDocs,
} from "../src/docs.js";

/**
 * Offline proof that a real analysis becomes a real `.docx` and `.pdf`:
 *
 *  - the seven mandatory sections all survive the mapping into the doc model,
 *  - the docx bytes are a zip (`PK`) carrying `word/document.xml`,
 *  - the pdf bytes start with `%PDF`,
 *  - Turkish characters (İ ş ğ ı) present in the analysis reach the docx text.
 *
 * No network, no API spend: `analysisToDocs` composes the publish package's real
 * renderers over a fixed AnalysisDoc. The publish package embeds a Unicode font
 * for the PDF and carries UTF-8 in the docx, so the only thing that could mangle
 * Turkish is this glue — which is exactly what these tests pin.
 */

const TICKET = "OPS-7";
const RUN_ID = "pilot-20260810120000";

// Turkish special characters on purpose: İ, ş, ğ, ı, ç, ö, ü must survive.
const TURKISH = "İşçi ödemesi: kart limiti güncelleme — ağ geçidi ve şifre sıfırlama";

const ANALYSIS: AnalysisDoc = {
  templateVersion: "pilot-v3",
  language: "tr",
  purpose: `Amaç: ${TURKISH}`,
  scope: {
    included: ["ugurpay ödeme akışı", "kart limiti servisi"],
    excluded: ["mobil bildirimler"],
  },
  impactMatrix: [
    {
      appId: "ugurpay",
      impacted: true,
      summary: "Ödeme uç noktası kart limitini yeniden hesaplar",
      source: "primary_repo_discovery",
    },
    {
      appId: "ugurweb",
      impacted: false,
      summary: "Web arayüzü etkilenmez",
      source: "repo_card",
    },
  ],
  acceptanceCriteria: ["Limit aşımı reddedilir", "İşlem denetim izine yazılır"],
  uiApiChanges: "POST /odeme uç noktasına limit alanı eklenir",
  testApproach: "Birim ve sözleşme testleri; sınır değerleri doğrulanır",
  riskAndRollback: {
    risk: "Yanlış limit hesabı ödemeyi bloke edebilir",
    mitigation: "Özellik bayrağı arkasında dağıtım",
    rollback: "Bayrağı kapatıp önceki sürüme dön",
  },
  riskTier: "orta",
  riskReason: "Ödeme akışını doğrudan etkiler",
  clarificationsUsed: ["Limit para birimi TRY olarak varsayıldı"],
};

/**
 * Pull `word/document.xml` out of a docx (a zip) and inflate it — offline, with
 * only `node:zlib`. A docx stores each entry with a local file header; the entry
 * we want is DEFLATE-compressed, so a raw substring search would never find the
 * text. This walks the local headers, finds the entry by name, and inflates it.
 */
function docxDocumentXml(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  const target = "word/document.xml";
  for (let i = 0; i + 30 <= buf.length; i += 1) {
    if (buf.readUInt32LE(i) !== 0x04034b50) continue; // local file header magic "PK\x03\x04"
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.toString("utf8", i + 30, i + 30 + nameLen);
    if (name !== target) continue;
    const dataStart = i + 30 + nameLen + extraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);
    const raw = method === 0 ? data : inflateRawSync(data);
    return raw.toString("utf8");
  }
  throw new Error("word/document.xml not found in docx");
}

// The seven mandatory section headings, as the catalog renders them (M43).
// `renderAnalysisMarkdown` appends an eighth "clarifications used" section, so
// the model carries 8 numbered sections — but all SEVEN mandatory ones must be
// present and numbered in order.
//
// The catalog values still carry their own "1. ", "2. " prefixes, and the
// document model now strips them: numbering has ONE source, and it is the
// model's `number` field asserted below. A title that kept its catalog number
// printed "1. 1. Amaç ve iş değeri" in a document a reviewer opened, so the
// expectation is the BARE title here on purpose.
const MANDATORY_SECTIONS = [
  "publish.section.purpose",
  "publish.section.scope",
  "publish.section.impact",
  "publish.section.acceptance",
  "publish.section.ui_api",
  "publish.section.test_approach",
  "publish.section.risk",
].map((key) => stripLeadingNumber(t("tr", key)));

describe("analysisToDocModel — the neutral model", () => {
  it("maps all seven mandatory sections, in order, ahead of clarifications", () => {
    const model = analysisToDocModel(ANALYSIS, TICKET, RUN_ID, "2026-08-10");

    const titles = model.sections.map((s) => s.title);
    // Every mandatory heading is present, in the mandated order.
    expect(titles.slice(0, 7)).toEqual(MANDATORY_SECTIONS);
    // Plus the appended "clarifications" section → 8 numbered sections total.
    expect(model.sections).toHaveLength(8);
    expect(model.sections.every((s) => s.title.trim().length > 0)).toBe(true);
    expect(model.sections.map((s) => s.number)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
  });

  it("carries the ticket key and template version into the künye", () => {
    const model = analysisToDocModel(ANALYSIS, TICKET, RUN_ID, "2026-08-10");
    expect(model.imprint.ticket).toBe(TICKET);
    expect(model.imprint.version).toBe("pilot-v3");
    expect(model.imprint.date).toBe("2026-08-10");
  });
});

describe("analysisToDocs — real .docx and .pdf", () => {
  let docs: GeneratedDocs;

  it("renders both artefacts", async () => {
    docs = await analysisToDocs(ANALYSIS, TICKET, RUN_ID, () => new Date("2026-08-10T09:00:00Z"));
    expect(docs.pdf.bytes.byteLength).toBeGreaterThan(1000);
    expect(docs.docx.bytes.byteLength).toBeGreaterThan(1000);
  });

  it("the docx is a real zip (PK) with word/document.xml", () => {
    expect(Array.from(docs.docx.bytes.slice(0, 2))).toEqual([0x50, 0x4b]); // "PK"
    const xml = docxDocumentXml(docs.docx.bytes);
    expect(xml.length).toBeGreaterThan(0);
  });

  it("the pdf starts with %PDF and ends with an EOF marker", () => {
    expect(new TextDecoder().decode(docs.pdf.bytes.slice(0, 5))).toBe("%PDF-");
    expect(new TextDecoder("latin1").decode(docs.pdf.bytes.slice(-2048))).toContain("%%EOF");
  });

  it("keeps Turkish characters (İ ş ğ ı) in the docx text", () => {
    const xml = docxDocumentXml(docs.docx.bytes);
    for (const ch of ["İ", "ş", "ğ", "ı", "ç", "ö", "ü"]) {
      expect(xml).toContain(ch);
    }
    expect(xml).toContain("kart limiti");
  });

  it("labels each artefact with the right content type and file name", () => {
    expect(docs.pdf.contentType).toBe("application/pdf");
    expect(docs.docx.contentType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(docs.pdf.fileName).toBe("OPS-7-analiz.pdf");
    expect(docs.docx.fileName).toBe("OPS-7-analiz.docx");
  });
});

describe("docFileName", () => {
  it("builds `<ticket>-analiz.<kind>`", () => {
    expect(docFileName("OPS-7", "pdf")).toBe("OPS-7-analiz.pdf");
    expect(docFileName("PAY-42", "docx")).toBe("PAY-42-analiz.docx");
  });
});

describe("DocStore", () => {
  it("returns null before anything is stored", () => {
    const store = new DocStore();
    expect(store.get("pdf")).toBeNull();
    expect(store.get("docx")).toBeNull();
    expect(store.currentRunId()).toBeNull();
  });

  it("serves the stored documents and remembers the run", async () => {
    const store = new DocStore();
    const generated = await analysisToDocs(ANALYSIS, TICKET, RUN_ID);
    store.put(RUN_ID, generated);

    expect(store.currentRunId()).toBe(RUN_ID);
    expect(store.get("pdf")?.contentType).toBe(DOC_CONTENT_TYPE.pdf);
    expect(store.get("docx")?.contentType).toBe(DOC_CONTENT_TYPE.docx);
    expect(store.get("pdf")?.bytes.byteLength).toBeGreaterThan(0);
  });

  it("clears held documents when a new run starts", async () => {
    const store = new DocStore();
    store.put(RUN_ID, await analysisToDocs(ANALYSIS, TICKET, RUN_ID));
    store.clear();
    expect(store.get("pdf")).toBeNull();
    expect(store.currentRunId()).toBeNull();
  });
});

// -------------------------------------------------------------- attach (M103r)

interface AttachCall {
  ticketKey: string;
  fileName: string;
  contentType: string;
  size: number;
}

/**
 * A stubbed `addAttachment`-capable driver — the offline stand-in for the
 * concrete JiraCloudWorkPort. `mode` controls the failure the fail-soft test
 * needs; no network is ever touched.
 */
function stubWork(mode: "ok" | "throw-first" | "throw-second" = "ok"): {
  work: AttachCapableWork;
  calls: AttachCall[];
} {
  const calls: AttachCall[] = [];
  const work: AttachCapableWork = {
    addAttachment(ticketKey, fileName, bytes, contentType) {
      calls.push({ ticketKey, fileName, contentType, size: bytes.byteLength });
      if (mode === "throw-first" && calls.length === 1) throw new Error("jira 500");
      if (mode === "throw-second" && calls.length === 2) throw new Error("jira 500");
      return Promise.resolve({ ids: [`att-${calls.length}`] });
    },
  };
  return { work, calls };
}

function collectLog(): { log: (kind: "ok" | "warn", message: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (kind, message) => lines.push(`${kind}:${message}`), lines };
}

describe("attachAnalysisDocs (M103r — auto-attach to Jira)", () => {
  it("attaches BOTH files, docx then pdf, with the right names and content types", async () => {
    const generated = await analysisToDocs(ANALYSIS, TICKET, RUN_ID);
    const { work, calls } = stubWork("ok");
    const { log, lines } = collectLog();

    const result = await attachAnalysisDocs(work, TICKET, generated, log);

    expect(result.attached).toBe(true);
    expect(result.ids).toEqual(["att-1", "att-2"]);
    expect(calls).toHaveLength(2);
    // docx first, then pdf — deterministic order.
    expect(calls[0]).toMatchObject({
      ticketKey: TICKET,
      fileName: "OPS-7-analiz.docx",
      contentType: DOC_CONTENT_TYPE.docx,
    });
    expect(calls[1]).toMatchObject({
      ticketKey: TICKET,
      fileName: "OPS-7-analiz.pdf",
      contentType: DOC_CONTENT_TYPE.pdf,
    });
    expect(calls[0]!.size).toBeGreaterThan(0);
    expect(lines).toContain("ok:✓ analiz belgesi Jira'ya eklendi: 2 dosya");
  });

  it("FAIL-SOFT: an attach failure never throws and reports attached=false", async () => {
    const generated = await analysisToDocs(ANALYSIS, TICKET, RUN_ID);
    const { work } = stubWork("throw-first");
    const { log, lines } = collectLog();

    // Must resolve, not reject — the run must continue.
    const result = await attachAnalysisDocs(work, TICKET, generated, log);

    expect(result.attached).toBe(false);
    expect(lines.some((l) => l.startsWith("warn:") && l.includes("eklenemedi"))).toBe(true);
    expect(lines).not.toContain("ok:✓ analiz belgesi Jira'ya eklendi: 2 dosya");
  });

  it("FAIL-SOFT: a partial failure (pdf fails after docx) still resolves attached=false", async () => {
    const generated = await analysisToDocs(ANALYSIS, TICKET, RUN_ID);
    const { work, calls } = stubWork("throw-second");
    const { log } = collectLog();

    const result = await attachAnalysisDocs(work, TICKET, generated, log);

    expect(result.attached).toBe(false);
    expect(calls).toHaveLength(2); // it tried both
    expect(result.ids).toEqual(["att-1"]); // only the first landed
  });
});
