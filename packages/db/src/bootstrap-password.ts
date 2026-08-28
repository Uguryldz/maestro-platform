import { randomInt } from "node:crypto";

/**
 * Random bootstrap/reset passwords (M8 hardening).
 *
 * Used in exactly two places, both operator-facing: the first-run admin seed
 * (`seed-first-admin.ts`, printed ONCE in the migrate log) and the
 * `reset-admin.sh` flow (`apps/deploy/src/reset-admin.ts`, printed ONCE on the
 * operator's terminal). Both accounts are forced through the change-password
 * screen on first login, so a generated password is a CORRIDOR, not a
 * credential anyone keeps — but it still has to survive the walk: it is read
 * off a terminal and typed into a login form by a human, which is why the
 * alphabet below drops the characters people mistake for each other
 * (`0/O`, `1/l/I`) and sticks to symbols that need no shell escaping to say
 * out loud.
 *
 * The generated password deliberately SATISFIES the platform's own policy
 * (apps/bff/src/auth/password.ts — upper/lower/digit/symbol, and 20 > the
 * 8-char minimum). The seed path is technically policy-exempt, but a generated
 * credential that the policy would reject teaches the operator the policy is
 * decorative. A test pins this agreement.
 */

/** Long enough that brute force is off the table for a credential that lives minutes. */
export const BOOTSTRAP_PASSWORD_LENGTH = 20;

// No 0/O/o, no 1/l/I — the password is transcribed from a terminal by eye.
const UPPER = "ABCDEFGHJKMNPQRSTUVWXYZ";
const LOWER = "abcdefghjkmnpqrstuvwxyz";
const DIGIT = "23456789";
/** Symbols that read unambiguously and paste cleanly into a login form. */
const SYMBOL = "!@#%+*?=-";
const ALL = UPPER + LOWER + DIGIT + SYMBOL;

/**
 * `randomInt`'s shape, injectable so the tests can drive the generator
 * deterministically. The default is node's CSPRNG — never `Math.random`, which
 * would make the very first admin credential of a bank guessable from the
 * process start time.
 */
export type RandomIntFn = (maxExclusive: number) => number;

/**
 * One password: guaranteed to contain at least one character of each class,
 * with every remaining position drawn from the full alphabet and the whole
 * thing shuffled (Fisher–Yates over the same CSPRNG) so the guaranteed
 * characters do not sit at predictable positions.
 */
export function generateBootstrapPassword(random: RandomIntFn = randomInt): string {
  const pick = (alphabet: string): string => alphabet[random(alphabet.length)] as string;

  const chars = [pick(UPPER), pick(LOWER), pick(DIGIT), pick(SYMBOL)];
  while (chars.length < BOOTSTRAP_PASSWORD_LENGTH) chars.push(pick(ALL));

  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = random(i + 1);
    const a = chars[i] as string;
    chars[i] = chars[j] as string;
    chars[j] = a;
  }
  return chars.join("");
}
