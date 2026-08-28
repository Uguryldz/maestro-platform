import { describe, expect, it } from "vitest";
import {
  assertRealDocument,
  deliverAnalysisDocs,
  docFileName,
  MIN_DOC_BYTES,
  readablePin,
} from "../src/impl/analysis-docs.js";
import { deliverAnalysis } from "../src/impl/delivery.js";
import { fakeDocBytes, makeFakes } from "./fakes.js";
import { analysisDoc } from "./harness.js";

/**
 * The analysis Word/PDF on the ticket (M103r) — the capability the pilot proved
 * on live tickets, now on the Temporal path.
 *
 * The pilot rendered the files itself; these tests pin the platform's rule
 * instead: generation is a PUBLISH PORT call, so the bytes go through the
 * port's PII gate and land in the object store, and only then are they copied
 * onto the ticket.
 */

const DOC = analysisDoc("orta");

describe("deliverAnalysisDocs (M103r)", () => {
  it("renders BOTH documents through the publish port and puts them on the ticket", async () => {
    const fakes = makeFakes();
    const result = await deliverAnalysisDocs(fakes.deps, await fakes.deps.runs.get("PAY-101"), "PAY-101", DOC);

    expect(result.attached).toBe(true);
    expect(result.problem).toBeNull();
    expect(result.files.map((f) => f.target)).toEqual(["docx", "pdf"]);
    expect(fakes.recorded.attached.map((a) => a.fileName)).toEqual([
      "PAY-101-analiz.docx",
      "PAY-101-analiz.pdf",
    ]);
    // The MIME types Jira stores the attachment under — a `.docx` announced as
    // `application/pdf` opens in the wrong application on the reviewer's desk.
    expect(fakes.recorded.attached.map((a) => a.contentType)).toEqual([
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/pdf",
    ]);
  });

  it("generates through the PUBLISH PORT, so the bytes pass the PII gate", async () => {
    const fakes = makeFakes();
    await deliverAnalysisDocs(fakes.deps, await fakes.deps.runs.get("PAY-101"), "PAY-101", DOC);

    // Not `renderDocx`/`renderPdf` directly (which is what the pilot did, and
    // is how its attachments bypassed masking): one publish request naming
    // both binary targets. `MaestroPublishPort` masks before any driver sees it.
    const published = fakes.recorded.published.filter((p) => p.targets.includes("docx"));
    expect(published).toHaveLength(1);
    expect(published[0]?.targets).toEqual(["docx", "pdf"]);
    expect(published[0]?.doc).toBe("analysis");
  });

  it("attaches the SAME bytes that were retained in the object store", async () => {
    const fakes = makeFakes();
    const result = await deliverAnalysisDocs(fakes.deps, await fakes.deps.runs.get("PAY-101"), "PAY-101", DOC);

    for (const file of result.files) {
      const stored = await fakes.deps.storage.get(file.storageKey);
      expect(Array.from(file.bytes)).toEqual(Array.from(stored));
    }
    // The attachment is a copy of the record, not a second render.
    expect(fakes.recorded.attached.map((a) => a.bytes)).toEqual(result.files.map((f) => f.bytes.byteLength));
  });

  it("is idempotent: a retried delivery uploads no second file", async () => {
    const fakes = makeFakes();
    const run = await fakes.deps.runs.get("PAY-101");
    await deliverAnalysisDocs(fakes.deps, run, "PAY-101", DOC);
    await deliverAnalysisDocs(fakes.deps, run, "PAY-101", DOC);

    // Temporal retries the activity; the ticket must not collect four files.
    expect(fakes.recorded.attached).toHaveLength(2);
    expect(fakes.recorded.published.filter((p) => p.targets.includes("docx"))).toHaveLength(1);
  });

  it("writes the M83 template pin into the journal, not only into the file", async () => {
    const fakes = makeFakes();
    await deliverAnalysisDocs(fakes.deps, await fakes.deps.runs.get("PAY-101"), "PAY-101", DOC);

    const generated = fakes.journalStore.entries.find((e) => e.title === "analiz belgesi üretildi");
    // The version is exact and READABLE. Written `analysis@1.0.0` the journal
    // masker takes it for an email and stores `[EMAIL_1.…]`, which loses the
    // one fact M83 keeps the pin for — see `readablePin`.
    expect(generated?.detail).toContain("şablon analysis sürüm 1.0.0");
    expect(generated?.detail).not.toContain("EMAIL_");
    // Which files, and how big — the two facts that say a real document exists.
    expect(generated?.detail).toContain("PAY-101-analiz.docx");
    expect(generated?.detail).toContain("PAY-101-analiz.pdf");
  });

  it("the pin survives the journal masker (the trap that ate the raw form)", () => {
    expect(readablePin("analysis@1.0.0")).toBe("analysis sürüm 1.0.0");
    // Nothing to split: passed through rather than mangled into a false pin.
    expect(readablePin("unpinned")).toBe("unpinned");
    expect(readablePin("analysis@")).toBe("analysis@");
  });

  it("records that the files reached the ticket as attachments", async () => {
    const fakes = makeFakes();
    await deliverAnalysisDocs(fakes.deps, await fakes.deps.runs.get("PAY-101"), "PAY-101", DOC);

    const attached = fakes.journalStore.entries.find((e) => e.title === "analiz belgesi ticket'a eklendi");
    expect(attached?.detail).toContain("2 dosya");
    expect(attached?.detail).toContain("PAY-101-analiz.pdf");
  });

  it("does nothing at all when there is no analysis (the engineering flow)", async () => {
    const fakes = makeFakes();
    const result = await deliverAnalysisDocs(fakes.deps, await fakes.deps.runs.get("PAY-101"), "PAY-101", null);

    expect(result.files).toEqual([]);
    expect(fakes.recorded.published).toHaveLength(0);
    expect(fakes.recorded.attached).toHaveLength(0);
  });
});

describe("deliverAnalysisDocs — fail-soft, but never silent", () => {
  it("an upload failure does NOT throw, and is written to the journal AND the ticket", async () => {
    const fakes = makeFakes({ attachFails: true });
    const result = await deliverAnalysisDocs(fakes.deps, await fakes.deps.runs.get("PAY-101"), "PAY-101", DOC);

    // The analysis comment and the assignment already stand; failing here would
    // burn three Temporal retries and kill a run whose deliverable is complete.
    expect(result.attached).toBe(false);
    expect(result.problem).toContain("413");
    // Said in BOTH places a human looks.
    const journal = fakes.journalStore.entries.find((e) => e.title === "analiz belgesi eksik");
    expect(journal?.detail).toContain("belge ticket'a eklenemedi");
    expect(journal?.detail).toContain("analiz teslimi etkilenmedi");
    expect(fakes.recorded.comments.map((c) => c.body)).toContainEqual("jira.analysis_docs_failed(PAY-101)");
  });

  it("a rendering failure does NOT throw, and is reported the same way", async () => {
    const fakes = makeFakes();
    const broken = {
      ...fakes.deps,
      publish: { publish: () => Promise.reject(new Error("renderer exploded")) },
    };
    const result = await deliverAnalysisDocs(broken, await fakes.deps.runs.get("PAY-101"), "PAY-101", DOC);

    expect(result.attached).toBe(false);
    expect(result.files).toEqual([]);
    expect(fakes.journalStore.entries.at(-1)?.title).toBe("analiz belgesi eksik");
    expect(fakes.recorded.comments.map((c) => c.body)).toContainEqual("jira.analysis_docs_failed(PAY-101)");
  });

  it("a deployment with no attacher stores the documents and SAYS they did not land", async () => {
    const fakes = makeFakes({ noDocAttacher: true });
    const result = await deliverAnalysisDocs(fakes.deps, await fakes.deps.runs.get("PAY-101"), "PAY-101", DOC);

    // Data Center: no attachment API. The documents still exist and are durable.
    expect(result.files).toHaveLength(2);
    expect(result.attached).toBe(false);
    const journal = fakes.journalStore.entries.find((e) => e.title === "analiz belgesi saklandı");
    expect(journal?.detail).toContain("bu kurulumda ek yükleme yok");
    // The object keys are in the line, so an operator can fetch the files.
    expect(journal?.detail).toContain("evidence/run-pay-101-0001/pdf");
  });

  it("a ticket that refuses comments still leaves the journal line standing", async () => {
    const fakes = makeFakes({ attachFails: true });
    const noComments = {
      ...fakes.deps,
      work: { ...fakes.deps.work, addComment: () => Promise.reject(new Error("jira: 403")) },
    };
    const result = await deliverAnalysisDocs(noComments, await fakes.deps.runs.get("PAY-101"), "PAY-101", DOC);

    expect(result.attached).toBe(false);
    expect(fakes.journalStore.entries.some((e) => e.title === "analiz belgesi eksik")).toBe(true);
  });
});

describe("assertRealDocument — an empty file is worse than no file", () => {
  it("accepts a plausible docx and pdf", () => {
    expect(() => assertRealDocument("pdf", "k", fakeDocBytes("pdf"))).not.toThrow();
    expect(() => assertRealDocument("docx", "k", fakeDocBytes("docx"))).not.toThrow();
  });

  it("refuses a file that is too small to be a document", () => {
    expect(() => assertRealDocument("pdf", "k", fakeDocBytes("pdf", MIN_DOC_BYTES - 1))).toThrow(
      /too small to be a real document/,
    );
  });

  it("refuses a zero-byte file", () => {
    expect(() => assertRealDocument("docx", "k", new Uint8Array(0))).toThrow(/too small/);
  });

  it("refuses bytes that do not carry the format's magic number", () => {
    // Big enough to pass the size floor, so ONLY the magic number can reject it
    // — the case a size check alone would wave through.
    const notAPdf = new Uint8Array(4096).fill(65);
    expect(() => assertRealDocument("pdf", "k", notAPdf)).toThrow(/does not start with %PDF-/);
    expect(() => assertRealDocument("docx", "k", notAPdf)).toThrow(/does not start with PK/);
  });

  it("a document whose bytes are broken never reaches the ticket", async () => {
    // The renderer "succeeded" and stored a stub. Nothing is attached.
    const fakes = makeFakes({ docBytes: (target) => fakeDocBytes(target, 40) });
    const result = await deliverAnalysisDocs(fakes.deps, await fakes.deps.runs.get("PAY-101"), "PAY-101", DOC);

    expect(result.attached).toBe(false);
    expect(fakes.recorded.attached).toHaveLength(0);
    expect(result.problem).toContain("too small");
  });
});

describe("docFileName", () => {
  it("names the file after the ticket, as the analyst files it", () => {
    expect(docFileName("OPS-9", "pdf")).toBe("OPS-9-analiz.pdf");
    expect(docFileName("OPS-9", "docx")).toBe("OPS-9-analiz.docx");
  });
});

describe("deliverAnalysis wiring (the `analiz` flow's last step)", () => {
  it("comments, attaches the documents, and assigns the ticket back", async () => {
    const fakes = makeFakes();
    await deliverAnalysis(fakes.deps, "PAY-101", DOC);

    expect(fakes.recorded.comments.map((c) => c.body)).toContain("jira.analysis_delivered(PAY-101,)");
    expect(fakes.recorded.attached).toHaveLength(2);
    expect(fakes.recorded.assignments).toHaveLength(1);
  });

  it("a document failure never costs the delivery: the ticket is still assigned", async () => {
    const fakes = makeFakes({ attachFails: true });
    await deliverAnalysis(fakes.deps, "PAY-101", DOC);

    // This is the whole point of fail-soft — the analysis IS the deliverable.
    expect(fakes.recorded.assignments).toHaveLength(1);
    expect(fakes.journalStore.entries.some((e) => e.title === "analiz belgesi eksik")).toBe(true);
    expect(fakes.journalStore.entries.some((e) => e.title === "analiz teslim edildi")).toBe(true);
  });

  it("the engineering flow's delivery (no document) attaches nothing", async () => {
    const fakes = makeFakes();
    await deliverAnalysis(fakes.deps, "PAY-101", null);

    expect(fakes.recorded.attached).toHaveLength(0);
    expect(fakes.recorded.assignments).toHaveLength(1);
  });
});
