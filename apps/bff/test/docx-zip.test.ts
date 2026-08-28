import { describe, expect, it } from "vitest";
import {
  DOCX_DOCUMENT_ENTRY,
  DOCX_STYLES_ENTRY,
  DocxReadError,
  looksLikeZip,
  readZipEntry,
  zipEntryNames,
} from "../src/docx-zip.js";
import { buildDocx, buildNonWordZip } from "./docx-fixtures.js";

/**
 * The zip reader, on its own.
 *
 * It parses bytes an admin uploaded, so the tests that matter are the ones
 * where the input is wrong. A reader that only ever sees well-formed archives
 * is a reader whose bounds have never been exercised, and the bounds are the
 * whole reason this file exists rather than a dependency.
 */

describe("looksLikeZip", () => {
  it("accepts a real .docx", async () => {
    expect(looksLikeZip(await buildDocx(["{{baslik}}"]))).toBe(true);
  });

  it("rejects a PDF, however it was named", () => {
    expect(looksLikeZip(new Uint8Array(Buffer.from("%PDF-1.7")))).toBe(false);
  });

  it("rejects a file too short to carry a signature", () => {
    expect(looksLikeZip(new Uint8Array([0x50, 0x4b]))).toBe(false);
  });
});

describe("readZipEntry", () => {
  it("reads word/document.xml out of a real .docx", async () => {
    const bytes = await buildDocx(["{{baslik}}", "{{ticket}}"]);

    const entry = readZipEntry(bytes, DOCX_DOCUMENT_ENTRY);

    expect(entry).not.toBeNull();
    const xml = Buffer.from(entry!).toString("utf8");
    expect(xml).toContain("<w:document");
    expect(xml).toContain("{{baslik}}");
  });

  it("reads word/styles.xml", async () => {
    const entry = readZipEntry(await buildDocx([]), DOCX_STYLES_ENTRY);

    expect(entry).not.toBeNull();
    expect(Buffer.from(entry!).toString("utf8")).toContain("Kurum Başlık");
  });

  it("returns null for an entry the archive does not have", () => {
    // Not an error: a `.docx` without `word/styles.xml` is a template with no
    // custom styles, which is a different thing from an unusable archive.
    expect(readZipEntry(buildNonWordZip(), DOCX_DOCUMENT_ENTRY)).toBeNull();
  });

  it("throws on bytes that are not a zip at all", () => {
    expect(() => readZipEntry(new Uint8Array(Buffer.from("hello".repeat(20))), "any")).toThrow(
      DocxReadError,
    );
  });

  it("throws on an archive whose central directory was truncated away", async () => {
    const bytes = await buildDocx(["{{baslik}}"]);
    // Cut the tail: the end-of-central-directory record goes with it, so the
    // archive's own index is gone and nothing in it can be trusted.
    const truncated = bytes.slice(0, bytes.byteLength - 40);

    expect(() => readZipEntry(truncated, DOCX_DOCUMENT_ENTRY)).toThrow(DocxReadError);
  });

  it("throws rather than reading past the end when the directory points outside the file", async () => {
    const bytes = await buildDocx(["{{baslik}}"]);
    const tampered = Uint8Array.from(bytes);
    const view = new DataView(tampered.buffer, tampered.byteOffset, tampered.byteLength);

    // Find the end record and inflate its claimed central-directory offset —
    // the classic way to walk a naive reader off the end of the buffer.
    let end = -1;
    for (let at = tampered.byteLength - 22; at >= 0 && end === -1; at--) {
      if (view.getUint32(at, true) === 0x06054b50) end = at;
    }
    expect(end).toBeGreaterThan(-1);
    view.setUint32(end + 16, 0xfffffff0, true);

    expect(() => readZipEntry(tampered, DOCX_DOCUMENT_ENTRY)).toThrow(DocxReadError);
  });
});

describe("zipEntryNames", () => {
  it("lists the OPC parts of a real .docx", async () => {
    const names = zipEntryNames(await buildDocx([]));

    // The two the scan needs, plus the package relationships every OPC file has.
    expect(names).toContain(DOCX_DOCUMENT_ENTRY);
    expect(names).toContain("[Content_Types].xml");
  });

  it("lists the single entry of a hand-built zip", () => {
    expect(zipEntryNames(buildNonWordZip())).toEqual(["readme.txt"]);
  });
});
