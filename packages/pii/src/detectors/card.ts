import type { Detector, PiiMatch } from "../types.js";
import { digitsOnly, SEPARATOR_RUN } from "./separators.js";

/**
 * 13..19 digits, grouped with any of the separators a clipboard produces
 * (space, NBSP, tab, dot, hyphen — see `separators.ts`). The old class was
 * `[ -]?`, which let `4000.0001.2345.6784` and a double-spaced number through
 * unmasked (verifier B-3).
 */
const CARD_RE = new RegExp(
  `(?<![0-9A-Za-z])(?:[0-9]${SEPARATOR_RUN}){12,18}[0-9](?![0-9A-Za-z])`,
  "gu",
);

/**
 * Luhn (mod-10) check. Mandatory: a 16-digit reference number that fails Luhn
 * is far more likely to be an order id than a PAN, and masking it would cost
 * the model context for nothing.
 */
export function isValidLuhn(digits: string): boolean {
  if (!/^[0-9]{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

export const cardDetector: Detector = {
  type: "card",
  scan(text: string): PiiMatch[] {
    const matches: PiiMatch[] = [];
    for (const m of text.matchAll(CARD_RE)) {
      const raw = m[0];
      if (m.index === undefined) continue;
      const digits = digitsOnly(raw);
      if (!isValidLuhn(digits)) continue;
      matches.push({
        type: "card",
        start: m.index,
        end: m.index + raw.length,
        text: raw,
        canonical: digits,
      });
    }
    return matches;
  },
};
