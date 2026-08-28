import { PiiPolicyError } from "../errors.js";
import { backtrackingRisk } from "../regex-safety.js";
import type { AccountPattern, Detector, DetectorContext, PiiMatch } from "../types.js";

/**
 * Customer / account / contract numbers have no checksum, so they cannot be
 * guessed — the institution declares their shape in the policy. Compilation
 * happens once, at policy load, so a broken pattern fails the process at
 * start-up instead of silently masking nothing at call time (fail-closed).
 */
export function compileAccountPatterns(patterns: readonly AccountPattern[]): RegExp[] {
  return patterns.map((p) => {
    // This pattern will run over every string of every payload on the LLM hot
    // path, so a pattern that backtracks exponentially is a denial of service
    // with the operator's own signature on it (B-18).
    const risk = backtrackingRisk(p.pattern);
    if (risk !== null) {
      throw new PiiPolicyError(`account pattern "${p.name}" is unsafe to run: ${risk}`);
    }
    let compiled: RegExp;
    try {
      compiled = new RegExp(p.pattern, "g");
    } catch (cause) {
      throw new PiiPolicyError(
        `account pattern "${p.name}" is not a valid regular expression: ${String(cause)}`,
      );
    }
    if (new RegExp(`^(?:${p.pattern})$`).test("")) {
      throw new PiiPolicyError(`account pattern "${p.name}" matches the empty string`);
    }
    return compiled;
  });
}

export const accountDetector: Detector = {
  type: "account",
  scan(text: string, ctx: DetectorContext): PiiMatch[] {
    const matches: PiiMatch[] = [];
    for (const re of ctx.accountPatterns) {
      for (const m of text.matchAll(re)) {
        const raw = m[0];
        if (m.index === undefined || raw.length === 0) continue;
        matches.push({
          type: "account",
          start: m.index,
          end: m.index + raw.length,
          text: raw,
          canonical: raw.toUpperCase(),
        });
      }
    }
    return matches;
  },
};
