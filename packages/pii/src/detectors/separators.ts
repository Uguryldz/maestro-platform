/**
 * The characters a human (or a clipboard) puts *inside* one identifier.
 *
 * `\p{Zs}` rather than a literal space because Word and Outlook paste
 * NBSP (U+00A0) and narrow no-break space (U+202F), and `\t` because Excel
 * pastes tabs — three spellings that used to travel to the model unmasked.
 * Newlines are deliberately excluded: an identifier that spans two lines is
 * far more likely to be two different numbers.
 */
export const SEPARATOR_CLASS = "[\\p{Zs}\\t.-]";

/** At most two separators between digits, so `4000  0001` and `123 - 456` fit. */
export const SEPARATOR_RUN = `${SEPARATOR_CLASS}{0,2}`;

const SEPARATOR = new RegExp(`^${SEPARATOR_CLASS}$`, "u");

export function isSeparator(ch: string): boolean {
  return SEPARATOR.test(ch);
}

/** Identity of a numeric identifier is its digits, whatever the spelling. */
export function digitsOnly(raw: string): string {
  return raw.replace(/[^0-9]/g, "");
}
