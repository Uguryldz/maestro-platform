/**
 * The envelope an egress function is allowed to receive.
 *
 * The previous version was an intersection brand, `T & { [BRAND]: "…" }`, and
 * the verifier walked past it five ways: `JSON.parse(JSON.stringify(raw))` is
 * `any` and `any` satisfies everything; a webhook body, a `res.json()` and a
 * Prisma `Json` column are `any` for the same reason; a single `as` was
 * enough; spreading a masked value *kept* the brand; and `Masked<any>`
 * collapsed to plain `any`.
 *
 * A class with a private field fixes four of those at compile time and the
 * fifth — `any` — where it actually matters: at run time. Two things now hold
 * that an intersection could never give:
 *
 * 1. `{ ...envelope }` loses the prototype and the private field, so a spread
 *    neither type-checks nor survives `Masked.is`.
 * 2. The payload lives *inside* the envelope. A caller who forces an `any`
 *    past the type system hands the callee something whose `.value` is
 *    `undefined`, so the raw data cannot physically reach the wire even if
 *    every check were removed.
 */
const MINT_KEY = Symbol("maestro.pii.masked");

export class Masked<T> {
  readonly #value: T;

  /** Not callable in practice: only this module holds the key. */
  constructor(key: symbol, value: T) {
    if (key !== MINT_KEY) {
      throw new TypeError("Masked payloads are minted by @maestro/pii, not constructed (M20)");
    }
    this.#value = value;
  }

  /** The masked payload. Reading it is how a callee builds its request body. */
  get value(): T {
    return this.#value;
  }

  /** So `JSON.stringify(envelope)` is the masked payload, not a wrapper. */
  toJSON(): T {
    return this.#value;
  }

  /** Runtime half of the guarantee: forged and spread envelopes fail here. */
  static is(value: unknown): value is Masked<unknown> {
    return typeof value === "object" && value !== null && #value in value;
  }
}

/** Internal minting. Deliberately not re-exported from the package index. */
export function mintMasked<T>(value: T): Masked<T> {
  return new Masked(MINT_KEY, value);
}
