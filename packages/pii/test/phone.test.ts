import { describe, expect, it } from "vitest";
import { canonicalPhone, phoneDetector } from "../src/detectors/index.js";
import { SAMPLE_TCKN } from "./synthetic.js";

const NO_PATTERNS = { accountPatterns: [] };

function found(text: string): string[] {
  return phoneDetector.scan(text, NO_PATTERNS).map((m) => m.text);
}

describe("phone detector — Turkish numbering plan", () => {
  it("accepts the spellings people actually paste into Jira", () => {
    expect(found("Ara: +90 532 111 22 33")).toEqual(["+90 532 111 22 33"]);
    expect(found("Ara: +905321112233")).toEqual(["+905321112233"]);
    expect(found("Ara: 0090 532 111 22 33")).toEqual(["0090 532 111 22 33"]);
    expect(found("Ara: 0532 111 22 33")).toEqual(["0532 111 22 33"]);
    expect(found("Ara: 05321112233")).toEqual(["05321112233"]);
    expect(found("Ara: (0212) 444 55 66")).toEqual(["(0212) 444 55 66"]);
    expect(found("Ara: 0212-444-55-66")).toEqual(["0212-444-55-66"]);
  });

  it("accepts a bare mobile number but not a bare fixed-line one", () => {
    expect(found("Numara 5321112233")).toEqual(["5321112233"]);
    // A bare 2xx-4xx run is far more likely an invoice or contract number.
    expect(found("Fatura 2124445566")).toEqual([]);
  });

  it("collapses every spelling of one number to a single identity", () => {
    const canon = "+905321112233";
    expect(canonicalPhone("+90 532 111 22 33")).toBe(canon);
    expect(canonicalPhone("05321112233")).toBe(canon);
    expect(canonicalPhone("0090-532-111-22-33")).toBe(canon);
    expect(canonicalPhone("(0532) 111 22 33")).toBe(canon);
  });

  it("does not fire on a TCKN, a year range or a longer digit run", () => {
    expect(found(SAMPLE_TCKN)).toEqual([]);
    expect(found("Toplam 123456789012 kayit")).toEqual([]);
    expect(found("2020-2024 arasi")).toEqual([]);
  });

  it("does not fire inside an e-mail local part boundary", () => {
    expect(found("kod 1234567890 gecersiz")).toEqual([]);
  });
});
