import { describe, expect, it } from "vitest";
import { cardDetector, isValidLuhn } from "../src/detectors/index.js";
import { makeCard, SAMPLE_CARD } from "./synthetic.js";

const NO_PATTERNS = { accountPatterns: [] };

describe("luhn", () => {
  it("accepts synthetic 16- and 19-digit numbers", () => {
    expect(isValidLuhn(SAMPLE_CARD)).toBe(true);
    expect(isValidLuhn(makeCard("400000012345678901"))).toBe(true);
  });

  it("rejects a mutated digit and out-of-range lengths", () => {
    const last = Number(SAMPLE_CARD.slice(-1));
    expect(isValidLuhn(`${SAMPLE_CARD.slice(0, -1)}${(last + 1) % 10}`)).toBe(false);
    expect(isValidLuhn("400000012")).toBe(false);
    expect(isValidLuhn(makeCard("4000000123456789012"))).toBe(false);
  });
});

describe("card detector", () => {
  it("finds contiguous and grouped numbers", () => {
    expect(cardDetector.scan(`Kart ${SAMPLE_CARD} ile odendi`, NO_PATTERNS)[0]?.text).toBe(
      SAMPLE_CARD,
    );
    const grouped = (SAMPLE_CARD.match(/.{4}/g) ?? []).join(" ");
    const [match] = cardDetector.scan(`Kart ${grouped} ile odendi`, NO_PATTERNS);
    expect(match?.text).toBe(grouped);
    // Grouped and contiguous spellings share one identity.
    expect(match?.canonical).toBe(SAMPLE_CARD);
  });

  it("leaves a 16-digit reference that fails Luhn alone (false-positive guard)", () => {
    const notACard = "1234567890123456";
    expect(isValidLuhn(notACard)).toBe(false);
    expect(cardDetector.scan(`Referans ${notACard}`, NO_PATTERNS)).toEqual([]);
  });

  it("does not fire on a TCKN-length run", () => {
    expect(cardDetector.scan("12345678950", NO_PATTERNS)).toEqual([]);
  });

  it("does not bleed into an adjacent number", () => {
    const [match] = cardDetector.scan(`${SAMPLE_CARD} 1234`, NO_PATTERNS);
    expect(match?.text).toBe(SAMPLE_CARD);
  });
});
