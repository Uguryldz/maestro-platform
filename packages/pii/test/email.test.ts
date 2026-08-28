import { describe, expect, it } from "vitest";
import { emailDetector } from "../src/detectors/index.js";

const NO_PATTERNS = { accountPatterns: [] };

function found(text: string): string[] {
  return emailDetector.scan(text, NO_PATTERNS).map((m) => m.text);
}

describe("email detector", () => {
  it("finds addresses in prose, including multi-label domains", () => {
    expect(found("Iletisim: ali.veli@banka.com.tr")).toEqual(["ali.veli@banka.com.tr"]);
    expect(found("a+etiket@alt-alan.example.org yaz")).toEqual(["a+etiket@alt-alan.example.org"]);
  });

  it("stops at the punctuation around the address", () => {
    expect(found("(ali@banka.com.tr), veli@banka.com.tr.")).toEqual([
      "ali@banka.com.tr",
      "veli@banka.com.tr",
    ]);
  });

  it("treats case as insignificant for identity", () => {
    const [match] = emailDetector.scan("Ali.Veli@Banka.COM.TR", NO_PATTERNS);
    expect(match?.canonical).toBe("ali.veli@banka.com.tr");
    expect(match?.text).toBe("Ali.Veli@Banka.COM.TR");
  });

  it("ignores things that are not addresses", () => {
    expect(found("kullanici@ hatali")).toEqual([]);
    expect(found("@maestro etiketi")).toEqual([]);
    expect(found("ali@localhost")).toEqual([]);
  });
});
