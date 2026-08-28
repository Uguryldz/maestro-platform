import { ExecutionConfigError } from "./errors.js";
import {
  DEFAULT_STRIKE_LIMIT,
  serialize,
  type StrikeKey,
  type StrikeLedgerPort,
  type StrikeState,
} from "./strikes.js";

/**
 * The counter, made to survive a restart (M54).
 *
 * `StrikeLedger` counts in a `Map`, which is correct for one process that
 * never stops. Neither holds here: a worker is redeployed mid-run, and a
 * Temporal activity can be retried on a DIFFERENT worker from the one that
 * recorded strike two. Both cases reset the count to zero, and "three
 * rejections at the same gate" then never arrives — the run retries the same
 * failing turn forever instead of reaching a human, which is precisely the
 * stuck-loop M54 exists to break.
 *
 * The storage is behind `StrikeStore` rather than Prisma so this package stays
 * database-free (M44); the composition root supplies the Postgres one.
 */

/** One persisted counter row. Mirrors `StrikeState` minus the derived fields. */
export interface StrikeRecord {
  readonly runId: string;
  readonly scope: string;
  readonly ref: string;
  readonly count: number;
  readonly firstAt: string;
  readonly lastAt: string;
  readonly reasons: readonly string[];
}

export interface StrikeStore {
  /** Every counter of one run. Called once, before the turn starts. */
  load(runId: string): Promise<readonly StrikeRecord[]>;
  /** Upsert by `(runId, scope, ref)`. */
  save(record: StrikeRecord): Promise<void>;
  remove(key: StrikeKey): Promise<void>;
}

export interface PersistentStrikeLedgerOptions {
  readonly store: StrikeStore;
  readonly now: () => Date;
  readonly limit?: number;
  /**
   * Where a write-behind failure goes.
   *
   * A failed save is NOT thrown from `record`: the turn has already failed for
   * its own reason, and replacing that reason with a database error would tell
   * the operator the wrong story. But it must not be silent either — a ledger
   * that quietly stopped persisting is a stuck-loop detector that has stopped
   * detecting, so the composition root logs it and `pendingWrites` lets a
   * caller wait for the queue before it decides the run is finished.
   */
  readonly onWriteError?: (error: unknown, key: StrikeKey) => void;
}

/**
 * Load-before, write-behind.
 *
 * `record`/`clear` stay synchronous — `AgentExecution` calls them from inside
 * the turn's verdict — so the durable write is queued rather than awaited. The
 * queue is serialised per key and drained by `pendingWrites()`, which the
 * caller awaits at the end of a turn. That ordering is what makes the count
 * correct across a restart: the in-memory answer is always the one derived
 * from the state that was LOADED plus the strikes recorded since, and the row
 * catches up a moment later.
 */
export class PersistentStrikeLedger implements StrikeLedgerPort {
  private readonly states = new Map<string, StrikeState>();
  /** Runs whose counters have been read back; a second load is skipped. */
  private readonly loaded = new Set<string>();
  private readonly limit: number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: PersistentStrikeLedgerOptions) {
    this.limit = options.limit ?? DEFAULT_STRIKE_LIMIT;
    if (!Number.isInteger(this.limit) || this.limit < 1) {
      throw new ExecutionConfigError(`strike limit must be a positive integer, got ${this.limit}`);
    }
  }

  /**
   * Reads a run's counters back into memory. MUST be awaited before the run's
   * first `record`, and it is the whole point of the class: a turn that counts
   * from an unloaded ledger starts at zero on every redeploy.
   *
   * Idempotent per run, and it does NOT overwrite a state recorded since the
   * load — a retry that reloads mid-turn would otherwise roll the count back
   * to whatever the row said before this turn's strike was queued.
   */
  async hydrate(runId: string): Promise<void> {
    if (this.loaded.has(runId)) return;
    const records = await this.options.store.load(runId);
    this.loaded.add(runId);
    for (const record of records) {
      const key: StrikeKey = { runId: record.runId, scope: asScope(record.scope), ref: record.ref };
      const id = serialize(key);
      if (this.states.has(id)) continue;
      this.states.set(id, this.toState(key, record.count, record.firstAt, record.lastAt, record.reasons));
    }
  }

  record(key: StrikeKey, reason: string): StrikeState {
    const at = this.options.now().toISOString();
    const previous = this.states.get(serialize(key));
    const count = (previous?.count ?? 0) + 1;
    const state = this.toState(
      key,
      count,
      previous?.firstAt ?? at,
      at,
      [...(previous?.reasons ?? []), reason].slice(-this.limit),
    );
    this.states.set(serialize(key), state);
    this.enqueue(key, () =>
      this.options.store.save({
        runId: key.runId,
        scope: key.scope,
        ref: key.ref,
        count: state.count,
        firstAt: state.firstAt,
        lastAt: state.lastAt,
        reasons: state.reasons,
      }),
    );
    return state;
  }

  clear(key: StrikeKey): void {
    this.states.delete(serialize(key));
    this.enqueue(key, () => this.options.store.remove(key));
  }

  state(key: StrikeKey): StrikeState | null {
    return this.states.get(serialize(key)) ?? null;
  }

  stuckKeys(runId: string): StrikeState[] {
    return [...this.states.values()].filter((s) => s.key.runId === runId && s.handover);
  }

  /**
   * Resolves when every queued write has been attempted.
   *
   * Awaited at the end of a turn, so a worker that is about to hand over — or
   * about to be shut down — does not lose the strike that justified it. Never
   * rejects: failures already went to `onWriteError`, and a rejection here
   * would surface a storage problem as the turn's outcome.
   */
  async pendingWrites(): Promise<void> {
    await this.queue.catch(() => undefined);
  }

  /** Drops a finished run's counters from memory. The ROWS stay. */
  forget(runId: string): void {
    this.loaded.delete(runId);
    for (const [id, state] of this.states) {
      if (state.key.runId === runId) this.states.delete(id);
    }
  }

  private toState(
    key: StrikeKey,
    count: number,
    firstAt: string,
    lastAt: string,
    reasons: readonly string[],
  ): StrikeState {
    return {
      key,
      count,
      limit: this.limit,
      firstAt,
      lastAt,
      // Derived from the CURRENT limit rather than stored: M71 can change the
      // limit between turns, and a stored `handover` would keep answering with
      // the value that was configured when the row was written.
      handover: count >= this.limit,
      reasons: reasons.slice(-this.limit),
    };
  }

  /** Serialised: two writes to one key must not race into the wrong order. */
  private enqueue(key: StrikeKey, write: () => Promise<void>): void {
    this.queue = this.queue.then(write).catch((error: unknown) => {
      this.options.onWriteError?.(error, key);
    });
  }
}

/**
 * A stored scope, narrowed back to the union.
 *
 * The column is text, so a row could in principle hold anything. An unknown
 * value falls to `agent` rather than throwing: a ledger that refuses to
 * hydrate over one malformed row would take down every run on that worker, and
 * the counter's job is to notice repetition, which it can still do.
 */
function asScope(scope: string): StrikeKey["scope"] {
  return scope === "gate" || scope === "ci" ? scope : "agent";
}
