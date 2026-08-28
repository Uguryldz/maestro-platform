import { describe, expect, it } from "vitest";
import { canonicalIban, ibanDetector, isValidIban } from "../src/detectors/index.js";
import { groupIban, makeIban, SAMPLE_TR_IBAN } from "./synthetic.js";

const NO_PATTERNS = { accountPatterns: [] };

describe("iban mod-97", () => {
  it("accepts TR and non-TR IBANs alike (general mode)", () => {
    expect(isValidIban(SAMPLE_TR_IBAN)).toBe(true);
    expect(isValidIban(makeIban("DE", "370400440532013000"))).toBe(true);
    expect(isValidIban(makeIban("GB", "NWBK60161331926819"))).toBe(true);
  });

  it("rejects a mutated check digit", () => {
    const check = Number(SAMPLE_TR_IBAN.slice(2, 4));
    const broken = `TR${String((check + 1) % 100).padStart(2, "0")}${SAMPLE_TR_IBAN.slice(4)}`;
    expect(isValidIban(broken)).toBe(false);
  });

  it("rejects a TR IBAN of the wrong length even when mod-97 would pass", () => {
    const short = makeIban("TR", "000120000000001234");
    expect(short).toHaveLength(22);
    expect(isValidIban(short)).toBe(false);
  });
});

describe("iban detector", () => {
  it("finds a contiguous IBAN", () => {
    const [match] = ibanDetector.scan(`Iade hesabi ${SAMPLE_TR_IBAN} numarasina yapilacak`, NO_PATTERNS);
    expect(match?.text).toBe(SAMPLE_TR_IBAN);
    expect(match?.canonical).toBe(SAMPLE_TR_IBAN);
  });

  it("finds a space-grouped IBAN and normalises it to the same identity", () => {
    const grouped = groupIban(SAMPLE_TR_IBAN);
    expect(grouped).toContain(" ");
    const [match] = ibanDetector.scan(`IBAN ${grouped} kayitli`, NO_PATTERNS);
    expect(match?.text).toBe(grouped);
    expect(match?.canonical).toBe(SAMPLE_TR_IBAN);
  });

  it("does not swallow a following upper-case word (greedy-scan regression)", () => {
    const grouped = groupIban(SAMPLE_TR_IBAN);
    const [match] = ibanDetector.scan(`${grouped} IBAN NUMARASI`, NO_PATTERNS);
    expect(match?.text).toBe(grouped);
    const [contiguous] = ibanDetector.scan(`${SAMPLE_TR_IBAN} IBAN`, NO_PATTERNS);
    expect(contiguous?.text).toBe(SAMPLE_TR_IBAN);
  });

  it("ignores a product code that merely looks like an IBAN", () => {
    expect(ibanDetector.scan("Urun kodu AB12CDEF3456789012 guncellendi", NO_PATTERNS)).toEqual([]);
  });

  it("canonicalises case and whitespace", () => {
    expect(canonicalIban(" tr33 0006 ")).toBe("TR330006");
  });
});
