/**
 * Account patterns are the one place an operator writes a regular expression
 * that this package then runs over every string of every payload. A pattern
 * like `(a+)+b` turns a Jira description into minutes of CPU (verifier B-18),
 * and the masker sits on the hot path of every LLM call, so the check belongs
 * at load time — the same place a syntactically broken pattern already fails.
 *
 * This is a conservative heuristic, not a decision procedure: it rejects the
 * nested-quantifier shape that causes exponential backtracking and caps the
 * pattern length. It cannot prove a surviving pattern is safe, which is why
 * RAPOR §7 records it as a bounded, reviewed risk.
 */

/** Long enough for every identifier shape a bank has, short enough to read. */
export const MAX_PATTERN_LENGTH = 200;

const UNBOUNDED = new Set(["*", "+"]);

/** `{2,}` is unbounded; `{2,8}` is not. */
function unboundedBraceAt(source: string, at: number): boolean {
  const close = source.indexOf("}", at);
  if (close === -1) return false;
  return /^\{\d*,\}$/.test(source.slice(at, close + 1));
}

function isUnboundedQuantifier(source: string, at: number): boolean {
  const ch = source.charAt(at);
  if (UNBOUNDED.has(ch)) return true;
  return ch === "{" && unboundedBraceAt(source, at);
}

/**
 * True when an unbounded quantifier is applied to a group that already
 * contains one — the `(x+)+` family, whose match time is exponential.
 */
export function hasNestedQuantifier(source: string): boolean {
  const openings: number[] = [];
  let inClass = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source.charAt(i);
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch === "(") {
      openings.push(i);
      continue;
    }
    if (ch !== ")") continue;

    const open = openings.pop();
    if (open === undefined) continue;
    if (!isUnboundedQuantifier(source, i + 1)) continue;
    if (containsUnboundedQuantifier(source.slice(open + 1, i))) return true;
  }
  return false;
}

/** Same scan, one level down: does this group body repeat without a bound? */
function containsUnboundedQuantifier(body: string): boolean {
  let inClass = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body.charAt(i);
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (isUnboundedQuantifier(body, i)) return true;
  }
  return false;
}

/** Why this pattern is refused, or `null` when it passes the heuristic. */
export function backtrackingRisk(source: string): string | null {
  if (source.length > MAX_PATTERN_LENGTH) {
    return `pattern is longer than ${MAX_PATTERN_LENGTH} characters`;
  }
  if (hasNestedQuantifier(source)) {
    return "a repeated group repeats without a bound ((x+)+ style), which backtracks exponentially";
  }
  return null;
}
