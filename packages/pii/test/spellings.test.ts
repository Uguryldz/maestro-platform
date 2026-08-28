import { describe, expect, it } from "vitest";
import {
  cardDetector,
  emailDetector,
  ibanDetector,
  tcknDetector,
} from "../src/detectors/index.js";
import { makeCard, makeTckn, SAMPLE_CARD, SAMPLE_TCKN, SAMPLE_TR_IBAN } from "./synthetic.js";

/**
 * Separator and case regressions (verifier B-1 / B-2 / B-3 / B-13). Every case
 * below was proven to travel to the model unmasked. They are spelling
 * variations a bank actually produces: Word and Outlook paste NBSP, Excel
 * pastes TAB, humans type "TC: 123 456 789 50", and any upstream
 * `.toLowerCase()` (log normalisation, search index, Jira field processing)
 * turns every IBAN into lower case.
 */

const NO_PATTERNS = { accountPatterns: [] };
const NBSP = " ";
const TAB = "\t";

/** Re-spell a digit run in groups joined by `sep`, the way people write it. */
function group(digits: string, sizes: readonly number[], sep: string): string {
  const parts: string[] = [];
  let at = 0;
  for (const size of sizes) {
    parts.push(digits.slice(at, at + size));
    at += size;
  }
  if (at < digits.length) parts.push(digits.slice(at));
  return parts.join(sep);
}

describe("tckn accepts the spellings a bank actually writes (B-1)", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["single spaces", group(SAMPLE_TCKN, [3, 3, 3, 2], " ")],
    ["hyphens", group(SAMPLE_TCKN, [3, 3, 5], "-")],
    ["dots", group(SAMPLE_TCKN, [3, 3, 3, 2], ".")],
    ["non-breaking spaces (Word/Outlook paste)", group(SAMPLE_TCKN, [3, 3, 3, 2], NBSP)],
    ["tabs (Excel paste)", group(SAMPLE_TCKN, [3, 3, 3, 2], TAB)],
  ];

  it.each(cases)("masks a TCKN written with %s", (_name, spelled) => {
    expect(spelled).not.toBe(SAMPLE_TCKN);
    const [match] = tcknDetector.scan(`Musteri TC: ${spelled} olarak kayitli`, NO_PATTERNS);
    expect(match?.text).toBe(spelled);
    // Every spelling is the same person: one token, one identity.
    expect(match?.canonical).toBe(SAMPLE_TCKN);
  });

  it("still refuses a separated run whose checksum does not hold", () => {
    const broken = group("12345678901", [3, 3, 3, 2], " ");
    expect(tcknDetector.scan(`Siparis no ${broken} iptal`, NO_PATTERNS)).toEqual([]);
  });

  it("does not carve a TCKN out of a grouped card number", () => {
    const grouped = group(SAMPLE_CARD, [4, 4, 4, 4], " ");
    expect(tcknDetector.scan(grouped, NO_PATTERNS)).toEqual([]);
  });

  it("does not run across a line break", () => {
    const split = `${SAMPLE_TCKN.slice(0, 6)}\n${SAMPLE_TCKN.slice(6)}`;
    expect(tcknDetector.scan(split, NO_PATTERNS)).toEqual([]);
  });
});

describe("iban is case-insensitive (B-2)", () => {
  it("masks a lower-cased IBAN — the shape any .toLowerCase() upstream produces", () => {
    const lowered = SAMPLE_TR_IBAN.toLowerCase();
    const [match] = ibanDetector.scan(`Iade ${lowered} hesabina`, NO_PATTERNS);
    expect(match?.text).toBe(lowered);
    expect(match?.canonical).toBe(SAMPLE_TR_IBAN);
  });

  it("masks a mixed-case IBAN and gives it the same identity", () => {
    const mixed = `Tr${SAMPLE_TR_IBAN.slice(2)}`;
    const [match] = ibanDetector.scan(`IBAN ${mixed}`, NO_PATTERNS);
    expect(match?.canonical).toBe(SAMPLE_TR_IBAN);
  });

  it("still ignores a lower-cased product code that fails mod-97", () => {
    expect(ibanDetector.scan("urun kodu ab12cdef3456789012 guncellendi", NO_PATTERNS)).toEqual([]);
  });
});

describe("iban accepts wider separators (B-3)", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["non-breaking spaces", group(SAMPLE_TR_IBAN, [4, 4, 4, 4, 4, 4], NBSP)],
    ["tabs", group(SAMPLE_TR_IBAN, [4, 4, 4, 4, 4, 4], TAB)],
    ["dots", group(SAMPLE_TR_IBAN, [4, 4, 4, 4, 4, 4], ".")],
    ["hyphens", group(SAMPLE_TR_IBAN, [4, 4, 4, 4, 4, 4], "-")],
    ["double spaces", group(SAMPLE_TR_IBAN, [4, 4, 4, 4, 4, 4], "  ")],
  ];

  it.each(cases)("masks an IBAN grouped with %s", (_name, spelled) => {
    const [match] = ibanDetector.scan(`Hesap ${spelled} numarasi`, NO_PATTERNS);
    expect(match?.text).toBe(spelled);
    expect(match?.canonical).toBe(SAMPLE_TR_IBAN);
  });
});

describe("card accepts wider separators (B-3)", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["dots", group(SAMPLE_CARD, [4, 4, 4, 4], ".")],
    ["double spaces", group(SAMPLE_CARD, [4, 4, 4, 4], "  ")],
    ["non-breaking spaces", group(SAMPLE_CARD, [4, 4, 4, 4], NBSP)],
    ["tabs", group(SAMPLE_CARD, [4, 4, 4, 4], TAB)],
  ];

  it.each(cases)("masks a card grouped with %s", (_name, spelled) => {
    const [match] = cardDetector.scan(`Kart ${spelled} ile odendi`, NO_PATTERNS);
    expect(match?.text).toBe(spelled);
    expect(match?.canonical).toBe(SAMPLE_CARD);
  });

  it("still refuses a grouped run that fails Luhn", () => {
    const broken = makeCard("400000012345678").slice(0, -1) + "9";
    expect(cardDetector.scan(group(broken, [4, 4, 4, 4], " "), NO_PATTERNS)).toEqual([]);
  });
});

describe("email covers non-ASCII local parts and domains (B-13)", () => {
  it("masks the whole address when the local part carries Turkish letters", () => {
    const address = "ali.oztürk@banka.com.tr";
    const [match] = emailDetector.scan(`Musteri ${address} yazdi`, NO_PATTERNS);
    expect(match?.text).toBe(address);
  });

  it("masks an address whose local part is entirely non-ASCII", () => {
    const address = "alı@banka.com.tr";
    const [match] = emailDetector.scan(`Musteri ${address} yazdi`, NO_PATTERNS);
    expect(match?.text).toBe(address);
  });

  it("masks an internationalised domain", () => {
    const address = "ayse@bankaşubesi.com.tr";
    const [match] = emailDetector.scan(`Adres: ${address}`, NO_PATTERNS);
    expect(match?.text).toBe(address);
  });

  it("keeps one identity per address regardless of case", () => {
    const [match] = emailDetector.scan("ALI@BANKA.COM.TR", NO_PATTERNS);
    expect(match?.canonical).toBe("ali@banka.com.tr");
  });
});

describe("checksum guards survive the wider spellings", () => {
  it("does not treat a separated non-TCKN as a TCKN", () => {
    const notTckn = makeTckn("111111111");
    expect(notTckn).toHaveLength(11);
    const mutated = `${notTckn.slice(0, 10)}${(Number(notTckn.slice(10)) + 1) % 10}`;
    expect(tcknDetector.scan(group(mutated, [3, 3, 3, 2], " "), NO_PATTERNS)).toEqual([]);
  });
});
