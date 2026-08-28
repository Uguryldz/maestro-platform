/**
 * Synthetic test data (M95). Nothing here is a real identifier: every value
 * is built from an arbitrary prefix, with the check digits computed so the
 * detectors have something checksum-valid to accept. No fixture in this
 * package may contain a personal value copied from anywhere.
 */

/** 9 arbitrary digits in, a checksum-valid 11-digit TCKN out. */
export function makeTckn(first9: string): string {
  if (!/^[1-9][0-9]{8}$/.test(first9)) throw new Error("first9 must be 9 digits, not starting with 0");
  let odd = 0;
  let even = 0;
  let sum = 0;
  for (let i = 0; i < 9; i += 1) {
    const digit = first9.charCodeAt(i) - 48;
    sum += digit;
    if (i % 2 === 0) odd += digit;
    else even += digit;
  }
  const tenth = (((odd * 7 - even) % 10) + 10) % 10;
  const eleventh = (sum + tenth) % 10;
  return `${first9}${tenth}${eleventh}`;
}

function mod97(input: string): number {
  let remainder = 0;
  for (const ch of input) {
    const code = ch.charCodeAt(0);
    const part = code >= 65 ? String(code - 55) : ch;
    for (let i = 0; i < part.length; i += 1) {
      remainder = (remainder * 10 + (part.charCodeAt(i) - 48)) % 97;
    }
  }
  return remainder;
}

/** BBAN in, a mod-97-valid IBAN out. TR needs a 22-character BBAN. */
export function makeIban(country: string, bban: string): string {
  const check = 98 - mod97(`${bban}${country}00`);
  return `${country}${String(check).padStart(2, "0")}${bban}`;
}

/** Groups a TR IBAN the way people paste it into Jira. */
export function groupIban(iban: string): string {
  return (iban.match(/.{1,4}/g) ?? []).join(" ");
}

/** Arbitrary leading digits in, a Luhn-valid card number out. */
export function makeCard(prefix: string): string {
  let sum = 0;
  let double = true;
  for (let i = prefix.length - 1; i >= 0; i -= 1) {
    let digit = prefix.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return `${prefix}${(10 - (sum % 10)) % 10}`;
}

/** A stable set of distinct synthetic TCKNs, for token-numbering tests. */
export function tcknSeries(count: number): string[] {
  return Array.from({ length: count }, (_, i) => makeTckn(String(100000000 + i * 7919)));
}

export const SAMPLE_TCKN = makeTckn("123456789");
export const SAMPLE_TR_IBAN = makeIban("TR", "0001200000000012345678");
export const SAMPLE_CARD = makeCard("400000012345678");
