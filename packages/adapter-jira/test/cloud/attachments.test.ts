import { describe, expect, it } from "vitest";
import { isTextAttachment, normalizeAttachments } from "../../src/cloud/attachments.js";

/**
 * Attachment metadata parsing must be robust: the `attachment` field may be
 * absent, null, or hold incomplete entries, and none of those is an error — an
 * issue with no attachments is normal. Text-detection decides which attachments
 * are read inline vs merely named.
 */
describe("normalizeAttachments", () => {
  it("returns [] when the field is absent, null, or not an array", () => {
    expect(normalizeAttachments({})).toEqual([]);
    expect(normalizeAttachments({ fields: {} })).toEqual([]);
    expect(normalizeAttachments({ fields: { attachment: null } })).toEqual([]);
    expect(normalizeAttachments({ fields: { attachment: "nope" } })).toEqual([]);
    expect(normalizeAttachments(null)).toEqual([]);
  });

  it("maps well-formed attachments and defaults a missing mime type", () => {
    const raw = {
      fields: {
        attachment: [
          { id: "1", filename: "hata.png", mimeType: "image/png", size: 12345, content: "https://x/1" },
          { id: "2", filename: "spec.txt", size: 40, content: "https://x/2" }, // no mimeType
        ],
      },
    };
    const out = normalizeAttachments(raw);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: "1", filename: "hata.png", mimeType: "image/png", size: 12345 });
    expect(out[1]?.mimeType).toBe("application/octet-stream");
  });

  it("drops entries missing id, filename or content URL — never fakes them", () => {
    const raw = {
      fields: {
        attachment: [
          { id: "1", filename: "ok.txt", content: "https://x/1" },
          { filename: "no-id.txt", content: "https://x/2" },
          { id: "3", content: "https://x/3" }, // no filename
          { id: "4", filename: "no-url.txt" }, // no content
        ],
      },
    };
    expect(normalizeAttachments(raw).map((a) => a.filename)).toEqual(["ok.txt"]);
  });
});

describe("isTextAttachment", () => {
  it("treats text/* and common structured text as readable", () => {
    expect(isTextAttachment("text/plain")).toBe(true);
    expect(isTextAttachment("text/markdown")).toBe(true);
    expect(isTextAttachment("application/json")).toBe(true);
    expect(isTextAttachment("application/xml")).toBe(true);
  });
  it("treats images and PDFs as non-text (named only)", () => {
    expect(isTextAttachment("image/png")).toBe(false);
    expect(isTextAttachment("application/pdf")).toBe(false);
    expect(isTextAttachment("application/octet-stream")).toBe(false);
  });
});
