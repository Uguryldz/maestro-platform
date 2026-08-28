import type { AuditEvent } from "@maestro/contracts";
import { AuditChainError } from "./errors.js";

/**
 * The persistence seam. This package deliberately owns no database: the chain
 * is pure logic so it can be unit-tested exhaustively offline, and so the same
 * rules apply whether records land in Postgres (`AuditLog`, wave 1 `db`), in a
 * file, or in a test double. Prisma is never imported here.
 *
 * A store must be append-only. `append` is expected to reject a non-advancing
 * `seq`, a duplicate `hash` and a duplicate `prevHash` at the storage level too
 * (`AuditLog` has a unique index on both hashes): the chain lock orders writers
 * inside one process, the unique indexes are what stop a second process from
 * forking the chain.
 */
export interface AuditStore {
  /** Highest-`seq` record, or `null` for an empty chain. */
  head(): Promise<AuditEvent | null>;
  /** Append one record; must throw if `seq`, `hash` or `prevHash` already exists. */
  append(event: AuditEvent): Promise<void>;
  /** Records with `fromSeq <= seq <= toSeq`, ascending. Bounds are inclusive and optional. */
  read(range?: { fromSeq?: number; toSeq?: number }): Promise<AuditEvent[]>;
}

/**
 * Reference store used by tests, seeds and the offline demo. It enforces the
 * same three invariants the database indexes enforce, so a bug in the chain
 * shows up here rather than in production. A reference store that is weaker
 * than the real one hides exactly the failures tests exist to catch.
 */
export class InMemoryAuditStore implements AuditStore {
  private readonly events: AuditEvent[] = [];
  private readonly hashes = new Set<string>();
  private readonly prevHashes = new Set<string>();

  constructor(initial: readonly AuditEvent[] = []) {
    for (const event of initial) this.appendSync(event);
  }

  head(): Promise<AuditEvent | null> {
    return Promise.resolve(this.events.at(-1) ?? null);
  }

  // Async so a rejected append is a rejected promise, never a synchronous
  // throw out of a Promise-returning method.
  async append(event: AuditEvent): Promise<void> {
    this.appendSync(event);
  }

  read(range?: { fromSeq?: number; toSeq?: number }): Promise<AuditEvent[]> {
    const from = range?.fromSeq ?? Number.NEGATIVE_INFINITY;
    const to = range?.toSeq ?? Number.POSITIVE_INFINITY;
    return Promise.resolve(this.events.filter((event) => event.seq >= from && event.seq <= to));
  }

  private appendSync(event: AuditEvent): void {
    const previous = this.events.at(-1);
    if (previous && event.seq <= previous.seq) {
      throw new AuditChainError(
        "sequence_conflict",
        `seq ${event.seq} does not follow the stored head ${previous.seq}`,
      );
    }
    if (this.hashes.has(event.hash)) {
      throw new AuditChainError("hash_conflict", `hash ${event.hash} is already stored`);
    }
    // `AuditLog.prevHash` is `@unique`: two rows may never share a predecessor,
    // so the chain cannot fork and there is at most one genesis row (M33).
    if (this.prevHashes.has(event.prevHash)) {
      throw new AuditChainError(
        "prev_hash_conflict",
        `prevHash ${event.prevHash} is already claimed — a second record would fork the chain`,
      );
    }
    this.hashes.add(event.hash);
    this.prevHashes.add(event.prevHash);
    this.events.push(Object.freeze({ ...event }));
  }
}
