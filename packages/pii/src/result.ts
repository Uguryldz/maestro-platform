import type { DataClassName, MaskCounts } from "./types.js";

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/**
 * What comes back from `withPiiBoundary`.
 *
 * The revealed output — real values put back — used to sit next to the masked
 * one as a plain property, so a single `logger.info({ result })` wrote raw
 * identifiers into a record kept for ten years (verifier B-12, M82). It now
 * lives in a private field: `JSON.stringify`, `util.inspect`, a structured
 * clone and `Object.keys` all see the masked copy only, and getting the real
 * one is an explicit `reveal()` at the place that renders it to a human.
 */
export class PiiBoundaryResult<TOut> {
  readonly #output: TOut;

  constructor(
    /** Tokens intact — the copy that may be persisted (M20/M82). */
    readonly maskedOutput: TOut,
    output: TOut,
    /** What was masked on the way out. */
    readonly counts: MaskCounts,
    /** What had to be masked in the answer — see `withPiiBoundary` (B-11). */
    readonly outputCounts: MaskCounts,
    readonly dataClass: DataClassName,
    /** True when the declared class was unusable and the strictest won. */
    readonly fellBack: boolean,
  ) {
    this.#output = output;
  }

  /** Real values, for the screen the user is looking at. Never for storage. */
  reveal(): TOut {
    return this.#output;
  }

  toJSON(): Record<string, unknown> {
    return {
      maskedOutput: this.maskedOutput,
      counts: this.counts,
      outputCounts: this.outputCounts,
      dataClass: this.dataClass,
      fellBack: this.fellBack,
    };
  }

  [INSPECT](): string {
    return `PiiBoundaryResult { dataClass: '${this.dataClass}', masked: ${this.counts.occurrences}+${this.outputCounts.occurrences} }`;
  }
}
