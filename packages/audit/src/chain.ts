import type { AuditAction, AuditEvent } from "@maestro/contracts";
import { actionInfo } from "./actions.js";
import { assertActor } from "./actor.js";
import { AuditChainError } from "./errors.js";
import { GENESIS, sealEvent } from "./hash.js";
import type { AuditStore } from "./store.js";
import { verifyChain, type ChainVerification } from "./verify.js";

/** Injected clock — every test in this package is deterministic because of it. */
export interface Clock {
  now(): Date;
}

/**
 * Mutual exclusion around "read the head, write the next record". M33 makes the
 * worker activity the single writer, but "single writer" is a deployment fact,
 * not a guarantee: two concurrent activities in one worker would both read the
 * same head and mint two records with the same `seq` and the same `prevHash`,
 * forking the chain.
 *
 * The lock is an interface so the real one can be a Postgres advisory lock in
 * the wave-3 worker without this package growing a database dependency.
 */
export interface ChainLock {
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * In-process serialiser: every call queues behind the previous one, and a
 * rejection does not poison the queue. Correct for one process only — that is
 * exactly the scope of "the worker is the only writer".
 */
export class LocalChainLock implements ChainLock {
  private tail: Promise<unknown> = Promise.resolve();

  withLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    // Swallow the value/error for the *queue* only; callers still see both.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export interface AuditChainOptions {
  readonly store: AuditStore;
  /** Defaults to an in-process lock; inject a distributed one in the worker. */
  readonly lock?: ChainLock;
  /** Defaults to the system clock. */
  readonly clock?: Clock;
}

export interface VerifyRange {
  /** Inclusive lower bound. Omitted (or 1) means "the whole chain, from genesis". */
  readonly fromSeq?: number;
  /** Inclusive upper bound. */
  readonly toSeq?: number;
  /**
   * Required when `fromSeq > 1`: the hash the slice must continue from, taken
   * from a signed anchor. There is no default — a missing expectation is a
   * refusal, never a pass.
   */
  readonly expectPrevHash?: string;
}

export interface AppendInput {
  readonly actor: string;
  readonly action: AuditAction;
  readonly subject: string;
  readonly meta?: Record<string, unknown>;
  /** Overrides the clock when the event's own instant is known (replays, backfills). */
  readonly at?: Date | string;
}

/**
 * The single implementation of the audit chain (M33). Every record is sealed
 * with `H(seq | at | actor | action | subject | prevHash | canonical(meta))`,
 * the first one pointing at `"genesis"`.
 */
export class AuditChain {
  private readonly store: AuditStore;
  private readonly lock: ChainLock;
  private readonly clock: Clock;

  constructor(options: AuditChainOptions) {
    this.store = options.store;
    this.lock = options.lock ?? new LocalChainLock();
    this.clock = options.clock ?? { now: () => new Date() };
  }

  head(): Promise<AuditEvent | null> {
    return this.store.head();
  }

  /**
   * Read the stored events, optionally sliced by sequence range. A pure
   * read-through to the store — appends stay the only mutation path — so a
   * caller that must PRESENT the trail (a regulator export, an audit screen)
   * can get the records without reaching past the chain into its store.
   */
  read(range?: { fromSeq?: number; toSeq?: number }): Promise<AuditEvent[]> {
    return this.store.read(range);
  }

  /** Append one record. Serialised against every other append on this chain. */
  append(input: AppendInput): Promise<AuditEvent> {
    return this.lock.withLock(async () => {
      const [event] = await this.sealAll([input]);
      if (!event) throw new AuditChainError("not_an_event", "append produced no record");
      return event;
    });
  }

  /**
   * Append several records as one linked run. Held under a single lock so no
   * other writer can interleave into the middle of a run's story.
   */
  appendMany(inputs: readonly AppendInput[]): Promise<AuditEvent[]> {
    return this.lock.withLock(() => this.sealAll(inputs));
  }

  /**
   * Re-verify the stored chain against an expectation the records cannot
   * influence.
   *
   * Without a range this is always "seq 1, pointing at genesis". Deriving the
   * expectation from the first record on hand — the shortcut a slice check
   * invites — is a fail-open: deleting the first records, emptying the table or
   * re-sealing the chain from a forged genesis all produce a chain that agrees
   * with itself, and the verifier would report `ok`.
   *
   * A slice that does not start at seq 1 must therefore carry `expectPrevHash`
   * from *outside* the database — a signed anchor's `headHash` is the intended
   * source (M33). Without it the verification is refused, not softened.
   */
  async verify(range?: VerifyRange): Promise<ChainVerification> {
    const fromSeq = range?.fromSeq;
    const startsAtGenesis = fromSeq === undefined || fromSeq <= 1;

    if (startsAtGenesis) {
      if (range?.expectPrevHash !== undefined && range.expectPrevHash !== GENESIS) {
        throw new AuditChainError(
          "unanchored_slice",
          `a verification that starts at seq 1 must expect ${GENESIS}, not ${range.expectPrevHash}`,
        );
      }
      return verifyChain(await this.store.read(range), { expectFirstSeq: 1, expectPrevHash: GENESIS });
    }

    if (range?.expectPrevHash === undefined) {
      throw new AuditChainError(
        "unanchored_slice",
        `verifying from seq ${fromSeq} needs expectPrevHash from a signed anchor; the records cannot vouch for their own start`,
      );
    }

    return verifyChain(await this.store.read(range), {
      expectFirstSeq: fromSeq,
      expectPrevHash: range.expectPrevHash,
    });
  }

  private async sealAll(inputs: readonly AppendInput[]): Promise<AuditEvent[]> {
    let head = await this.store.head();
    const written: AuditEvent[] = [];

    for (const input of inputs) {
      const identity = assertActor(input.actor);
      if (actionInfo(input.action).humanOnly && identity.kind !== "human") {
        // M32/M101: an approval that an AI or a system account could write is
        // not a control. Refuse at the trail, not only in the workflow.
        throw new AuditChainError(
          "actor_not_human",
          `${input.action} may only be recorded for a human actor, got ${input.actor}`,
        );
      }

      const event = sealEvent({
        seq: (head?.seq ?? 0) + 1,
        at: this.instant(input.at),
        actor: input.actor,
        action: input.action,
        subject: input.subject,
        prevHash: head?.hash ?? GENESIS,
        meta: input.meta ?? {},
      });

      await this.store.append(event);
      head = event;
      written.push(event);
    }

    return written;
  }

  /**
   * Normalised to UTC with millisecond precision, so the stored `at` and the
   * hashed `at` are the same string and two writers in different time zones
   * cannot produce different hashes for the same instant.
   */
  private instant(at: AppendInput["at"]): string {
    const date = at === undefined ? this.clock.now() : at instanceof Date ? at : new Date(at);
    if (Number.isNaN(date.getTime())) {
      throw new AuditChainError("not_an_event", `event timestamp ${String(at)} is not a valid instant`);
    }
    return date.toISOString();
  }
}
