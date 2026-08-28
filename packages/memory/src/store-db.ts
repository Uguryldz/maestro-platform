import type { JournalEntry } from "@maestro/contracts";
import { toJournalEntry, type AppendOnlyDb } from "@maestro/db";
import { SeqTakenError } from "./errors.js";
import type { JournalStore } from "./types.js";

/**
 * The journal half of `@maestro/db`'s append-only surface (M30/M33). Taking
 * this type rather than `Db` is the point: the delegate handed in here has no
 * `update` and no `delete` to call, on top of the database triggers that
 * refuse them anyway.
 */
export type JournalDelegate = AppendOnlyDb["journalEntry"];

/** Postgres unique violation, as Prisma reports it and as the driver reports it. */
function isSeqConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "P2002" || code === "23505";
}

/**
 * Bind the journal store to Postgres.
 *
 * The `(runId, seq)` primary key does the concurrency work: two runners that
 * pick the same seq both try to insert it, exactly one commits, and the loser
 * gets a `SeqTakenError` it can retry. No advisory lock, no sequence object,
 * no gap — the head of the journal is whatever is committed.
 *
 * `AppendOnlyDelegate` is a structural type, so a caller *can* hand in a
 * wider object — the type stops this module from naming `update`, not a
 * caller from passing a client that has one (verifier D-13). The three
 * permitted methods are therefore captured here and the object is never
 * consulted again: nothing this store holds can reach a mutating method, whoever
 * passed what.
 */
export function journalStoreFromDb(delegate: JournalDelegate): JournalStore {
  const readHead = delegate.aggregate.bind(delegate);
  const insertRow = delegate.create.bind(delegate);
  const readRows = delegate.findMany.bind(delegate);

  return {
    async maxSeq(runId: string): Promise<number | null> {
      const aggregate = await readHead({ where: { runId }, _max: { seq: true } });
      return aggregate._max?.seq ?? null;
    },

    async insert(entry): Promise<void> {
      try {
        await insertRow({
          data: {
            runId: entry.runId,
            seq: entry.seq,
            at: new Date(entry.at),
            actor: entry.actor,
            kind: entry.kind,
            title: entry.title,
            detail: entry.detail,
            ...(entry.cost === undefined ? {} : { costJson: entry.cost }),
          },
        });
      } catch (error) {
        if (isSeqConflict(error)) throw new SeqTakenError(entry.runId, entry.seq);
        throw error;
      }
    },

    async list(runId: string, fromSeq?: number): Promise<JournalEntry[]> {
      const rows = await readRows({
        where: fromSeq === undefined ? { runId } : { runId, seq: { gte: fromSeq } },
        orderBy: { seq: "asc" },
      });
      return rows.map((row) => toJournalEntry(row));
    },
  };
}
