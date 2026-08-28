import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDocumentModel } from "../src/doc-model.js";
import { renderPdf } from "../src/pdf-render.js";
import { ANALYSIS_MARKDOWN } from "./doc-helpers.js";

/**
 * Pagination and text fidelity, checked with an EXTERNAL reader.
 *
 * `pdftotext` is poppler's, not ours: it is the closest cheap stand-in for the
 * Acrobat a bank reviewer will open the file in. Two things have already been
 * caught only by reading the output back — bullets drawn on top of each other,
 * and Turkish folded to `1`/`_` by a WinAnsi font — so the assertion is on the
 * EXTRACTED TEXT rather than on the fact that bytes were produced.
 *
 * Skipped, not failed, where poppler is absent: a developer laptop without it
 * must still be able to run the suite.
 */

const PDFTOTEXT = ["/usr/bin/pdftotext", "/usr/local/bin/pdftotext"].find((p) => existsSync(p));

function extract(bytes: Uint8Array, name: string): string {
  const pdf = `/tmp/${name}.pdf`;
  const txt = `/tmp/${name}.txt`;
  writeFileSync(pdf, bytes);
  execFileSync(PDFTOTEXT as string, ["-layout", pdf, txt]);
  return execFileSync("/bin/cat", [txt]).toString();
}

function model(markdown: string) {
  return buildDocumentModel({
    markdownSource: markdown,
    translate: (locale: string, key: string) => `${locale}:${key}`,
    locale: "tr",
    ticketKey: "UGURPAY-123",
    runId: "run-20260808-0001",
    templateVersion: "analysis-template@1.4.0",
    date: "2026-08-09",
  });
}

describe.skipIf(PDFTOTEXT === undefined)("pdf output read back with poppler", () => {
  it("renders Turkish, numbered sections and one bullet per line", async () => {
    const extracted = extract(await renderPdf(model(ANALYSIS_MARKDOWN)), "maestro-fidelity");

    // Turkish survived: a WinAnsi font would have written "Amac"/"1. Amaç" as
    // "Ama" + a mangled byte, and "artırım" as "art´r´m".
    expect(extracted).toContain("1. Amaç");
    expect(extracted).toContain("Kart limit artırım akışını otomatikleştirmek.");
    // Bullets on their own lines rather than overlapping each other.
    expect(extracted).toContain("Limit artırım servisi");
    expect(extracted).toContain("Mobil ekran");
    const bulletLines = extracted.split("\n").filter((line) => line.includes("•"));
    expect(bulletLines).toHaveLength(2);
  });

  it("footers each page with its own number and the true total", async () => {
    const long = [
      ANALYSIS_MARKDOWN,
      ...Array.from({ length: 60 }, (_, i) => `## Bölüm ${String(i + 4)}\n\nUzun bir paragraf metni.\n`),
    ].join("\n");

    const extracted = extract(await renderPdf(model(long)), "maestro-pagination");

    // "1 / 3", "2 / 3", "3 / 3" — a stale total would print "1 / 1" on page 2.
    const footers = [...extracted.matchAll(/(\d+)\s*\/\s*(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
    expect(footers.length).toBeGreaterThan(1);
    const total = footers[0]?.[1] ?? 0;
    expect(total).toBe(footers.length);
    expect(footers.map(([page]) => page)).toEqual(footers.map((_, index) => index + 1));
    expect(footers.every(([, t]) => t === total)).toBe(true);
  });
});
