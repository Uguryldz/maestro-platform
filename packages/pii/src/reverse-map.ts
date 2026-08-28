import { PiiReverseMapLeakError, PiiSessionError } from "./errors.js";
import {
  TOKEN_NONCE_PATTERN,
  TOKEN_PATTERN_SOURCE,
  TOKEN_PREFIX,
  type PiiType,
} from "./types.js";

const INSPECT = Symbol.for("nodejs.util.inspect.custom");
const TOKEN_LOOKUP = new RegExp(TOKEN_PATTERN_SOURCE, "g");

/**
 * 32 bits of session nonce. It is not a secret and it identifies nothing: its
 * only job is to make one session's token vocabulary disjoint from another's.
 */
function randomNonce(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * Token -> real value, scoped to one masking session (M20).
 *
 * Two rules this class enforces structurally rather than by convention:
 *
 * 1. The same value gets the same token for the whole session, so the model
 *    can reason ("[TCKN_1] appears in both the ticket and the log") without
 *    ever seeing the value.
 * 2. The map is not serialisable. Every path that would put it into a log
 *    line, a JSON body or a structured clone yields either an exception or a
 *    size-only summary. This is the structure that must never leave process
 *    memory, so `toJSON` throws instead of quietly emitting the values.
 * 3. Every token carries this session's nonce, so a token minted here is not
 *    a token anywhere else. Opening session A's text with session B's map now
 *    returns nothing instead of the wrong person (verifier B-8).
 */
export class ReverseMap {
  readonly #byToken = new Map<string, string>();
  readonly #byCanonical = new Map<string, string>();
  readonly #counters = new Map<PiiType, number>();
  readonly #nonce: string;

  /** A caller-supplied nonce keeps tests deterministic; production takes the default. */
  constructor(nonce: string = randomNonce()) {
    if (!TOKEN_NONCE_PATTERN.test(nonce)) {
      throw new PiiSessionError(`nonce must match ${String(TOKEN_NONCE_PATTERN)}`);
    }
    this.#nonce = nonce;
  }

  /** This session's token suffix. Random, value-free — safe to log. */
  get nonce(): string {
    return this.#nonce;
  }

  /** Number of distinct values held. Safe to log. */
  get size(): number {
    return this.#byToken.size;
  }

  /**
   * Token for one occurrence. `canonical` decides identity, `original` is what
   * `unmask` restores; the first spelling seen wins, later spellings of the
   * same value reuse the token.
   */
  tokenFor(type: PiiType, canonical: string, original: string): string {
    const key = `${type}:${canonical}`;
    const existing = this.#byCanonical.get(key);
    if (existing !== undefined) return existing;
    const next = (this.#counters.get(type) ?? 0) + 1;
    this.#counters.set(type, next);
    const token = `[${TOKEN_PREFIX[type]}_${next}.${this.#nonce}]`;
    this.#byCanonical.set(key, token);
    this.#byToken.set(token, original);
    return token;
  }

  /** True when the token was minted by this session. */
  has(token: string): boolean {
    return this.#byToken.has(token);
  }

  /**
   * Put the real values back into model output (M20: only on the way to a
   * human). Tokens this session never minted are left untouched — a model
   * that invents `[TCKN_9.…]`, a user who typed one, and another session's
   * token all get no answer rather than someone else's value.
   */
  unmask(text: string): string {
    if (this.#byToken.size === 0) return text;
    return text.replace(TOKEN_LOOKUP, (token) => this.#byToken.get(token) ?? token);
  }

  toJSON(): never {
    throw new PiiReverseMapLeakError("toJSON");
  }

  toString(): string {
    return `ReverseMap(size=${this.size})`;
  }

  [INSPECT](): string {
    return `ReverseMap { size: ${this.size} }`;
  }
}
