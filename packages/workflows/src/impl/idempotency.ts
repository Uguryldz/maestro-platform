import type { IdempotencyGuard } from "./deps.js";

/**
 * Process-local idempotency guard.
 *
 * Temporal retries an activity that failed halfway, so "post the Jira comment,
 * then append the audit record" runs the comment twice unless something
 * remembers. This remembers, and it also SERIALISES: two concurrent calls with
 * the same key share one execution, which is what stops a duplicated signal
 * from opening two gates in the same millisecond.
 *
 * Scope is one worker process — enough for M33's "the worker is the single
 * writer", and deliberately not more: a deployment with several workers wires
 * a table-backed guard through the same interface.
 */
export class InMemoryIdempotency implements IdempotencyGuard {
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly done = new Map<string, unknown>();

  async once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.done.has(key)) return this.done.get(key) as T;
    const running = this.inflight.get(key);
    if (running !== undefined) return (await running) as T;

    const started = fn();
    this.inflight.set(key, started);
    try {
      const value = await started;
      this.done.set(key, value);
      return value;
    } finally {
      // A failure is NOT remembered: the point of the guard is to make a retry
      // safe, and a remembered failure would make it impossible.
      this.inflight.delete(key);
    }
  }

  /** Number of keys that completed — the assertion an idempotency test makes. */
  get size(): number {
    return this.done.size;
  }
}
