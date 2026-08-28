import type { AuditStore, ChainLock } from "@maestro/audit";
import type { AuditAction, AuditEvent } from "@maestro/contracts";
import { toAuditEvent, type AuditLogRow } from "@maestro/db";

/**
 * The Postgres-backed `AuditStore` and its cross-process chain lock (M33).
 *
 * `@maestro/audit` ships `InMemoryAuditStore` and `LocalChainLock`, and both
 * are correct for exactly one process. `LocalChainLock` serialises appends
 * inside a Node process; a second BFF replica writing the same chain does not
 * queue behind it, so both replicas read the same head, both mint `seq = n+1`
 * pointing at the same `prevHash`, and the chain forks. In an append-only
 * table with a unique index on `prevHash` the loser's INSERT is REJECTED
 * rather than silently accepted — which is the good outcome, and still an
 * error a bank's auditor sees as a lost record.
 *
 * So the lock has to be held by the DATABASE, which is the only thing both
 * replicas share. `pg_advisory_xact_lock` is that lock.
 *
 * Two properties make it the right one:
 *  · it is a TRANSACTION lock, released when the transaction ends — including
 *    when the process dies mid-append. A session lock (`pg_advisory_lock`)
 *    would survive a crashed worker and wedge the chain until somebody found
 *    it by hand.
 *  · it queues rather than fails. A second writer waits for the first to
 *    finish, which is exactly "one of them must wait".
 */

/** The `AuditLog` rows this store reads and writes. */
export interface AuditLogDelegate {
  findFirst(args: { orderBy: { seq: "desc" } }): Promise<AuditLogRow | null>;
  findMany(args: {
    where: { seq?: { gte?: bigint; lte?: bigint } };
    orderBy: { seq: "asc" };
  }): Promise<AuditLogRow[]>;
  create(args: { data: AuditLogWriteRow }): Promise<unknown>;
}

/**
 * The row as WRITTEN. `action` is the contract's union rather than `string`:
 * the column is a Prisma enum, and the generated client refuses a widened
 * type. That refusal is the useful kind — `AuditAction` and `AuditActionE` are
 * kept 1:1 by `packages/db/test/schema-enums.test.ts`, so an action this
 * platform can mint is always an action the column can store.
 */
export interface AuditLogWriteRow {
  seq: bigint;
  at: Date;
  actor: string;
  action: AuditAction;
  subject: string;
  prevHash: string;
  hash: string;
  /**
   * Declared as the JSON column's own input type rather than
   * `Record<string, unknown>`.
   *
   * `AuditEvent.meta` IS `Record<string, unknown>` — arbitrary, caller-built
   * JSON — and Prisma's `InputJsonValue` cannot express that: it demands a
   * recursively-serialisable type, which `unknown` values are not statically
   * known to be. The one narrowing lives at the write below, documented, so
   * the delegate stays assignable from the real client and the cast is in one
   * place instead of at every call site. The value is serialisable in fact:
   * `sealEvent` hashes `canonical(meta)`, which throws on anything that is not.
   */
  metaJson: object;
}

/**
 * The lock key. Advisory locks are a single 64-bit namespace shared by every
 * user of the database, so the constant is written down once, here, with a
 * name that says what it protects. `4d41 4553` is "MAES" in ASCII — a value
 * nobody picks by accident.
 */
export const AUDIT_CHAIN_LOCK_KEY = 0x4d414553n;

/** A transaction the lock can run inside. Prisma's `$transaction`, narrowed. */
export interface TransactionRunner {
  transaction<T>(fn: (tx: TransactionalSql) => Promise<T>): Promise<T>;
}

export interface TransactionalSql {
  query<R = unknown>(sql: string, params: readonly unknown[]): Promise<R[]>;
}

/**
 * A chain lock held by Postgres for the duration of one transaction.
 *
 * WHAT THIS GUARANTEES, precisely — because the boundary matters:
 *
 * `AuditChain.append` calls `withLock(fn)`, and `fn` both reads the head and
 * writes the record. The advisory lock is taken at the START of a transaction
 * and released when that transaction commits, which is AFTER `fn` resolves.
 * So the read-then-write critical section is genuinely serialised across
 * processes: a second writer's `pg_advisory_xact_lock` blocks until the first
 * one's transaction ends, and it therefore reads a head that already includes
 * the first one's record. That is the property that was missing, and the one
 * that stops two replicas from minting the same `seq`.
 *
 * WHAT IT DOES NOT DO: the store's INSERT does not run inside this
 * transaction. `ChainLock.withLock` takes a zero-argument callback
 * (`packages/audit/src/chain.ts`), so there is no way to hand the
 * transactional connection to the store that `AuditChain` already holds — the
 * write goes through the pooled client. The consequence is that the INSERT
 * commits independently of the lock transaction rather than atomically with
 * it. It is still ordered correctly (it happens before `fn` resolves, and so
 * before the lock is released), and `AuditLog`'s unique indexes on `seq`,
 * `hash` and `prevHash` reject anything that slipped through regardless.
 *
 * Making the write atomic with the lock needs `withLock` to pass a handle to
 * its callback — an interface change in a frozen-by-convention package. It is
 * filed as an ARAYÜZ İSTEĞİ in packages/db/RAPOR-dalga5.md rather than worked
 * around here with a second, unlocked chain implementation.
 */
export function postgresChainLock(runner: TransactionRunner): ChainLock {
  return {
    withLock<T>(fn: () => Promise<T>): Promise<T> {
      return runner.transaction(async (tx) => {
        // Blocks until every other holder has committed. There is no timeout
        // on purpose: an audit append is milliseconds of work, and giving up
        // on the lock would mean giving up on recording the event.
        //
        // The `::text` cast is not decoration: `pg_advisory_xact_lock` returns
        // `void`, and the client cannot deserialise a void column — the lock
        // would be taken and the call would then throw, turning a working lock
        // into a failed append. Casting gives the driver a type it can read.
        await tx.query("SELECT pg_advisory_xact_lock($1)::text", [AUDIT_CHAIN_LOCK_KEY]);
        return fn();
      });
    },
  };
}

export class PrismaAuditStore implements AuditStore {
  constructor(private readonly log: AuditLogDelegate) {}

  async head(): Promise<AuditEvent | null> {
    const row = await this.log.findFirst({ orderBy: { seq: "desc" } });
    return row === null ? null : toAuditEvent(row);
  }

  /**
   * Append one record.
   *
   * There is no "does this seq already exist" check here, and adding one would
   * be a downgrade: the unique indexes on `seq`, `hash` and `prevHash` are
   * checked by the database at INSERT time, atomically, and a pre-check would
   * be a race the guard is supposed to close. A rejected INSERT is the store
   * doing its job — `AuditStore` requires exactly that ("must throw if `seq`,
   * `hash` or `prevHash` already exists").
   */
  async append(event: AuditEvent): Promise<void> {
    await this.log.create({
      data: {
        seq: BigInt(event.seq),
        at: new Date(event.at),
        actor: event.actor,
        action: event.action,
        subject: event.subject,
        prevHash: event.prevHash,
        hash: event.hash,
        metaJson: event.meta,
      },
    });
  }

  async read(range?: { fromSeq?: number; toSeq?: number }): Promise<AuditEvent[]> {
    const bounds: { gte?: bigint; lte?: bigint } = {};
    if (range?.fromSeq !== undefined) bounds.gte = BigInt(range.fromSeq);
    if (range?.toSeq !== undefined) bounds.lte = BigInt(range.toSeq);
    const rows = await this.log.findMany({
      where: Object.keys(bounds).length === 0 ? {} : { seq: bounds },
      orderBy: { seq: "asc" },
    });
    return rows.map(toAuditEvent);
  }
}
