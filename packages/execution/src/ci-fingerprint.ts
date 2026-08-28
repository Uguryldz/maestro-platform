import { createHash } from "node:crypto";

/**
 * "The same CI error" for M54. Getting this wrong breaks the stuck-protection
 * in BOTH directions, and the two failures look nothing alike:
 *
 *  · Too coarse → two different failures share a counter and the run is handed
 *    to a human after one real rejection plus two unrelated ones. The previous
 *    version replaced every path with `<path>`, so `FAIL src/pay/mapper.test.ts`
 *    and `FAIL src/auth/login.test.ts` were the same string.
 *  · Too fine → one failure never accumulates. Any opaque token in the output
 *    (a correlation id, a temp directory, a generated fixture id) differs per
 *    run, so the counter restarts at 1 every time and M54 never fires at all —
 *    the infinite-loop protection is simply absent.
 *
 * So the fingerprint is not a hash of the output. Noise is normalised away,
 * then STRUCTURE is extracted — which test, which error class — and only those
 * signals are hashed. Anything the extractor does not recognise falls back to
 * the normalised text, which is coarse but never silently empty.
 */

/** One red verification command. */
export interface CiFailureInput {
  readonly name: string;
  readonly exitCode: number;
  /** stdout/stderr tail, in whatever shape the tool printed it. */
  readonly output: string;
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
const HEX = /\b[0-9a-f]{7,}\b/g;
/** Path-shaped token; only the basename survives — see `normalizeNoise`. */
const PATH = /(?:[a-z]:)?[\w.@+-]*\/[\w.@+/-]+/g;
/**
 * An opaque token: at least 8 chars with BOTH letters and digits. Deliberately
 * narrower than "8+ alphanumerics", which would also swallow `assertionerror`
 * and `referenceerror` — the error class is the single most useful signal here,
 * so a rule that erases it trades one failure mode for the other.
 */
const OPAQUE = /\b(?=[a-z0-9]*[0-9])(?=[a-z0-9]*[a-z])[a-z0-9]{8,}\b/g;
/** TypeScript diagnostic codes are kept: `TS2345` is the error's identity. */
const NUMBER = /\berror ts\d+\b|\d+(?:\.\d+)?(?:ms|s|m)?/g;

/**
 * Strip the parts that differ between two runs of ONE failure: absolute
 * workspace prefixes, temp directories, ids, durations, line numbers.
 *
 * Paths keep their basename rather than collapsing to `<path>`: `/w/run-1/
 * src/pay/mapper.test.ts` and `/w/run-2/src/pay/mapper.test.ts` must agree,
 * while `mapper.test.ts` and `login.test.ts` must not.
 */
export function normalizeNoise(text: string): string {
  return text
    .toLowerCase()
    .replace(/\r/g, "")
    .replace(UUID, "<id>")
    .replace(HEX, "<hex>")
    .replace(PATH, (match) => match.split("/").filter((s) => s !== "").pop() ?? "<path>")
    .replace(OPAQUE, "<tok>")
    .replace(NUMBER, (match) => (match.startsWith("error ts") ? match : "<n>"))
    .replace(/\s+/g, " ")
    .trim();
}

const TEST_ID = /(?:^|\s)(?:fail|✕|×|✗|●|not ok)\s+([^\n]{1,120})/g;
const ERROR_CLASS = /\b([a-z][a-z_]*(?:error|exception))\b/g;
const TS_DIAGNOSTIC = /\berror (ts\d+)\b/g;
const RUNTIME_CODE = /\b(elifecycle|enoent|eacces|eaddrinuse|econnrefused|etimedout|err_[a-z_]+)\b/g;

function collect(into: Set<string>, text: string, pattern: RegExp, prefix: string): void {
  // `pattern` is a module-level /g regex; reset before every scan.
  pattern.lastIndex = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    const value = (match[1] ?? "").trim();
    if (value !== "" && value !== "error") into.add(`${prefix}:${value}`);
    match = pattern.exec(text);
  }
}

/**
 * The structural signals in one command's output. Exported because "what did
 * we consider the identity of this failure" is exactly what a stuck-run's
 * handover note has to be able to show a human.
 */
export function ciSignals(output: string): string[] {
  const normalized = normalizeNoise(output);
  const signals = new Set<string>();
  collect(signals, normalized, TEST_ID, "test");
  collect(signals, normalized, TS_DIAGNOSTIC, "ts");
  collect(signals, normalized, ERROR_CLASS, "err");
  collect(signals, normalized, RUNTIME_CODE, "code");
  if (signals.size === 0 && normalized !== "") signals.add(`raw:${normalized}`);
  return [...signals].sort();
}

/**
 * Fingerprint for a set of red commands. The command's own identity (name and
 * exit code) is always part of it: a failing `lint` and a failing `test` are
 * not the same problem even when neither printed anything recognisable.
 */
export function ciFingerprint(failures: readonly CiFailureInput[]): string {
  const signals = new Set<string>();
  for (const failure of failures) {
    signals.add(`cmd:${failure.name}#${failure.exitCode}`);
    for (const signal of ciSignals(failure.output)) signals.add(signal);
  }
  return createHash("sha256").update([...signals].sort().join("\n")).digest("hex").slice(0, 16);
}
