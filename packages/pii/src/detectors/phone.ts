import type { Detector, PiiMatch } from "../types.js";

/**
 * Turkish numbering plan: optional `+90` / `0090` / trunk `0`, then a 3-digit
 * area or mobile prefix (2xx-5xx), then 3+2+2 digits with optional separators.
 */
const PHONE_RE =
  /(?<![0-9A-Za-z])(?:(?:\+|00)90[ .-]?)?\(?0?([2-5][0-9]{2})\)?[ .-]?[0-9]{3}[ .-]?[0-9]{2}[ .-]?[0-9]{2}(?![0-9A-Za-z])/g;

const HAS_PREFIX = /^(?:\+|00)90|^\(?0/;
const HAS_SEPARATOR = /[ .()-]/;

/**
 * A bare, unpunctuated 10-digit run is only accepted when it starts with 5
 * (mobile). Fixed-line prefixes overlap far too well with invoice, contract
 * and order numbers to be masked without a trunk prefix or grouping.
 */
function isPlausiblePhone(raw: string, areaCode: string): boolean {
  return HAS_PREFIX.test(raw) || HAS_SEPARATOR.test(raw) || areaCode.startsWith("5");
}

/** Every spelling of one number collapses to `+90XXXXXXXXXX`. */
export function canonicalPhone(raw: string): string {
  return `+90${raw.replace(/[^0-9]/g, "").slice(-10)}`;
}

export const phoneDetector: Detector = {
  type: "phone",
  scan(text: string): PiiMatch[] {
    const matches: PiiMatch[] = [];
    for (const m of text.matchAll(PHONE_RE)) {
      const raw = m[0];
      const areaCode = m[1];
      if (m.index === undefined || areaCode === undefined) continue;
      if (!isPlausiblePhone(raw, areaCode)) continue;
      matches.push({
        type: "phone",
        start: m.index,
        end: m.index + raw.length,
        text: raw,
        canonical: canonicalPhone(raw),
      });
    }
    return matches;
  },
};
