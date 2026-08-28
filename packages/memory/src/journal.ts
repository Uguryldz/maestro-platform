import type { JournalEntry } from "@maestro/contracts";
import { MemoryArgumentError, SeqAllocationError, SeqTakenError } from "./errors.js";
import type { JournalMasker } from "./masking.js";
import type { Clock, JournalDraft, JournalStore } from "./types.js";

/**
 * Retries are races, not failures, and one round can only ever be lost to a
 * writer that *committed* — so the budget has to cover the widest realistic
 * fan-out on a single run, not a guess at it. Fan-out steps, a CI signal and a
 * notification writing to the same run at once is a plausible twenty
 * (verifier Y-2, where a budget of 8 silently dropped entries at nine).
 */
export const DEFAULT_MAX_APPEND_ATTEMPTS = 32;

/** Backoff ceiling per attempt, before jitter. */
export const MAX_APPEND_BACKOFF_MS = 250;
const BASE_BACKOFF_MS = 4;
/**
 * Consecutive conflicts retried by walking the sequence forward before going
 * back to the store. A `SeqTakenError` proves that seq is committed, so the
 * next candidate is knowable without a round trip; only when the walk keeps
 * losing is the local view stale enough to be worth re-reading.
 */
const FAST_ADVANCE = 3;

export interface JournalDeps {
  readonly store: JournalStore;
  readonly masker: JournalMasker;
  readonly clock: Clock;
  /** Sequence-allocation attempts before giving up. Default 32. */
  readonly maxAttempts?: number;
  /**
   * Sleep between resynchronisation attempts. Injected so tests are offline
   * and instant; wiring leaves it alone and gets `setTimeout`.
   */
  readonly wait?: (ms: number) => Promise<void>;
}

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential, capped, jittered — the point is to break lockstep. */
function backoffMs(round: number): number {
  const base = Math.min(BASE_BACKOFF_MS * 2 ** round, MAX_APPEND_BACKOFF_MS);
  return Math.max(1, Math.round(base * (0.5 + Math.random() * 0.5)));
}

/**
 * Per (store, run) write chains. Two appends to the same run inside one
 * process queue instead of racing, which keeps the common case at exactly one
 * round trip; the retry loop below is what makes appends from *other*
 * processes safe. The WeakMap is keyed by the store so a discarded store takes
 * its chains with it.
 */
const chains = new WeakMap<JournalStore, Map<string, Promise<void>>>();

function noop(): void {
  /* the chain must never reject: it only orders work */
}

function serialize<T>(store: JournalStore, runId: string, task: () => Promise<T>): Promise<T> {
  let byRun = chains.get(store);
  if (byRun === undefined) {
    byRun = new Map();
    chains.set(store, byRun);
  }
  const previous = byRun.get(runId) ?? Promise.resolve();
  const result = previous.then(task);
  const tail = result.then(noop, noop);
  byRun.set(runId, tail);
  const runs = byRun;
  void tail.then(() => {
    if (runs.get(runId) === tail) runs.delete(runId);
  });
  return result;
}

/**
 * Append one entry to the ticket journal (M30).
 *
 * The only write API this package has. There is no update and no delete —
 * neither here nor on `JournalStore` — because the journal is the raw material
 * of the evidence package (M34) and of the living summary, and a rewritable
 * record is worth nothing to an auditor.
 *
 * Sequence numbers are allocated as `max(seq) + 1` and the store rejects a
 * duplicate primary key, so concurrent writers cannot collide and cannot leave
 * a hole: a seq only exists once its row is committed, and the next writer
 * reads that committed head. A loser of the race walks the sequence forward,
 * resynchronises with the store every few conflicts, and backs off with jitter
 * between resynchronisations so that N writers do not stay in lockstep.
 *
 * WIRING CONTRACT: build ONE `JournalStore` per process and share it. The
 * in-process write chain is keyed by the store object, so a store per activity
 * turns every append into a cross-writer race — survivable (that is what the
 * retry budget is for) but pointlessly expensive.
 *
 * The text is masked before it is sealed (M82) and the sealed entry is
 * re-checked for leaks, so raw PII can reach the journal neither through the
 * type system nor at runtime.
 */
export async function appendJournal(
  deps: JournalDeps,
  draft: JournalDraft,
): Promise<JournalEntry> {
  const attempts = deps.maxAttempts ?? DEFAULT_MAX_APPEND_ATTEMPTS;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new MemoryArgumentError("maxAttempts", "must be a positive integer");
  }
  const at = draft.at ?? deps.clock.now();
  const text = deps.masker.prepare({ title: draft.title, detail: draft.detail ?? "" });
  const identity = {
    runId: draft.runId,
    at,
    actor: draft.actor,
    kind: draft.kind,
    ...(draft.cost === undefined ? {} : { cost: draft.cost }),
  };

  const wait = deps.wait ?? sleep;

  return serialize(deps.store, draft.runId, async () => {
    let seq = -1;
    let sinceRead = 0;
    let round = 0;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (seq < 0 || sinceRead >= FAST_ADVANCE) {
        if (attempt > 0) {
          await wait(backoffMs(round));
          round += 1;
        }
        const head = await deps.store.maxSeq(draft.runId);
        seq = head === null ? 0 : head + 1;
        sinceRead = 0;
      }
      const entry = deps.masker.seal({ ...identity, seq }, text);
      try {
        await deps.store.insert(entry);
        return entry;
      } catch (error) {
        // Only a lost race is retryable. Anything else (a dead connection, a
        // constraint we do not own) must surface: a swallowed write is the
        // context loss this package exists to prevent.
        if (!(error instanceof SeqTakenError)) throw error;
        // The conflict itself is information: that seq is committed, so the
        // next candidate needs no round trip.
        seq += 1;
        sinceRead += 1;
      }
    }
    throw new SeqAllocationError(draft.runId, attempts);
  });
}
