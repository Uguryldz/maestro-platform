import { describe, expect, it } from "vitest";
import { isValidTckn, tcknDetector } from "../src/detectors/index.js";
import { makeTckn, SAMPLE_TCKN } from "./synthetic.js";

const NO_PATTERNS = { accountPatterns: [] };

describe("tckn checksum", () => {
  it("accepts a checksum-valid number", () => {
    expect(isValidTckn(SAMPLE_TCKN)).toBe(true);
    expect(isValidTckn(makeTckn("987654321"))).toBe(true);
  });

  it("rejects a number whose 10th check digit is wrong", () => {
    const valid = makeTckn("123456789");
    const tenth = Number(valid.charAt(9));
    const broken = `${valid.slice(0, 9)}${(tenth + 1) % 10}${valid.charAt(10)}`;
    expect(broken).not.toBe(valid);
    expect(isValidTckn(broken)).toBe(false);
  });

  it("rejects a number whose 11th check digit is wrong", () => {
    const valid = makeTckn("123456789");
    const eleventh = Number(valid.charAt(10));
    expect(isValidTckn(`${valid.slice(0, 10)}${(eleventh + 1) % 10}`)).toBe(false);
  });

  it("rejects a leading zero and the wrong length", () => {
    expect(isValidTckn(`0${SAMPLE_TCKN.slice(1)}`)).toBe(false);
    expect(isValidTckn(SAMPLE_TCKN.slice(0, 10))).toBe(false);
    expect(isValidTckn(`${SAMPLE_TCKN}0`)).toBe(false);
  });
});

describe("tckn detector", () => {
  it("finds the number in prose and reports its exact span", () => {
    const text = `Musteri TCKN: ${SAMPLE_TCKN} olarak kayitli.`;
    const [match] = tcknDetector.scan(text, NO_PATTERNS);
    expect(match).toBeDefined();
    expect(match?.text).toBe(SAMPLE_TCKN);
    expect(text.slice(match?.start ?? 0, match?.end ?? 0)).toBe(SAMPLE_TCKN);
    expect(match?.canonical).toBe(SAMPLE_TCKN);
  });

  it("leaves an 11-digit run that fails the checksum alone (false-positive guard)", () => {
    // A plausible order id, deliberately checksum-invalid.
    expect(isValidTckn("12345678901")).toBe(false);
    expect(tcknDetector.scan("Siparis no 12345678901 iptal edildi", NO_PATTERNS)).toEqual([]);
  });

  it("does not fire inside a longer digit run or glued to letters", () => {
    expect(tcknDetector.scan(`9${SAMPLE_TCKN}9`, NO_PATTERNS)).toEqual([]);
    expect(tcknDetector.scan(`REF${SAMPLE_TCKN}`, NO_PATTERNS)).toEqual([]);
    expect(tcknDetector.scan(`${SAMPLE_TCKN}X`, NO_PATTERNS)).toEqual([]);
  });

  it("finds every occurrence", () => {
    const other = makeTckn("987654321");
    const found = tcknDetector.scan(`${SAMPLE_TCKN} ve ${other}`, NO_PATTERNS);
    expect(found.map((m) => m.text)).toEqual([SAMPLE_TCKN, other]);
  });
});
