import type { Detector, PiiMatch } from "../types.js";
import { isSeparator, SEPARATOR_CLASS } from "./separators.js";

/**
 * Country code + check digits, case-insensitively.
 *
 * The `i` was missing (verifier B-2) and `canonicalIban` upper-cases anyway,
 * which is the proof it was an oversight rather than a decision. The dangerous
 * case is not a human typing `tr70…`: any upstream `.toLowerCase()` — log
 * normalisation, a search index, Jira field processing — used to disable IBAN
 * masking entirely.
 */
const IBAN_START = /(?<![0-9A-Za-z])[A-Za-z]{2}[0-9]{2}/g;

/** 34 significant characters with up to two separators between each. */
const MAX_RAW_LENGTH = 34 + 33 * 2;

/** Turkish IBANs are fixed length; anything else claiming TR is noise. */
const TR_IBAN_LENGTH = 26;

export function canonicalIban(raw: string): string {
  return raw.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}

/**
 * ISO 13616 mod-97 check (general mode) with the Turkish length rule on top.
 * The checksum is mandatory: without it every `XX99...` product code in a
 * ticket would be masked and the model would lose real context.
 */
export function isValidIban(canonical: string): boolean {
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(canonical)) return false;
  if (canonical.startsWith("TR") && canonical.length !== TR_IBAN_LENGTH) return false;
  const rearranged = canonical.slice(4) + canonical.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    // A..Z expand to 10..35; digits stay as they are.
    const part = code >= 65 ? String(code - 55) : ch;
    for (let i = 0; i < part.length; i += 1) {
      remainder = (remainder * 10 + (part.charCodeAt(i) - 48)) % 97;
    }
  }
  return remainder === 1;
}

const IBAN_BODY = new RegExp(`[A-Za-z0-9]|${SEPARATOR_CLASS}`, "u");
const ALNUM = /[0-9A-Za-z]/;

/**
 * From a candidate start, take the longest run of IBAN-shaped characters and
 * then shorten it until the checksum agrees. A plain greedy regex cannot do
 * this: `TR33 0006 ... 26 IBAN` would swallow the following word, fail mod-97
 * and report nothing — a false negative, which at a PII boundary is the one
 * kind of error that actually hurts.
 */
function longestValidFrom(text: string, start: number): PiiMatch | null {
  const limit = Math.min(text.length, start + MAX_RAW_LENGTH);
  let end = start + 4;
  while (end < limit && IBAN_BODY.test(text.charAt(end))) end += 1;
  for (let cut = end; cut > start + 4; cut -= 1) {
    const next = cut < text.length ? text.charAt(cut) : "";
    if (next !== "" && ALNUM.test(next)) continue;
    const raw = text.slice(start, cut);
    if (isSeparator(raw.slice(-1))) continue;
    const canonical = canonicalIban(raw);
    if (!isValidIban(canonical)) continue;
    return { type: "iban", start, end: cut, text: raw, canonical };
  }
  return null;
}

export const ibanDetector: Detector = {
  type: "iban",
  scan(text: string): PiiMatch[] {
    const matches: PiiMatch[] = [];
    for (const m of text.matchAll(IBAN_START)) {
      if (m.index === undefined) continue;
      const match = longestValidFrom(text, m.index);
      if (match !== null) matches.push(match);
    }
    return matches;
  },
};
