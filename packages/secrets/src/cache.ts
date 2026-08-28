/** Injected clock — every expiry decision in this package goes through it, so
 * tests are deterministic and never sleep. */
export type Clock = () => number;

export const systemClock: Clock = () => Date.now();

/**
 * Tiny TTL cache for resolved secret values.
 *
 * Two properties matter more than speed:
 *  1. An entry past its deadline is a MISS — an expired secret is never served.
 *  2. The entries live in a `#private` field, so `JSON.stringify(cache)` and
 *     `String(cache)` cannot leak a value even by accident (leak.test.ts).
 */
export class TtlCache<T> {
  readonly #entries = new Map<string, { value: T; expiresAtMs: number }>();
  readonly #ttlMs: number;
  readonly #clock: Clock;

  constructor(ttlSeconds: number, clock: Clock = systemClock) {
    this.#ttlMs = Math.max(0, ttlSeconds) * 1000;
    this.#clock = clock;
  }

  get enabled(): boolean {
    return this.#ttlMs > 0;
  }

  get(key: string): T | undefined {
    if (!this.enabled) return undefined;
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAtMs <= this.#clock()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    if (!this.enabled) return;
    this.#entries.set(key, { value, expiresAtMs: this.#clock() + this.#ttlMs });
  }

  clear(): void {
    this.#entries.clear();
  }

  /** Size only — deliberately no keys, no values. */
  toJSON(): { cachedEntries: number; ttlMs: number } {
    return { cachedEntries: this.#entries.size, ttlMs: this.#ttlMs };
  }

  toString(): string {
    return `TtlCache(entries=${this.#entries.size}, ttlMs=${this.#ttlMs})`;
  }
}
