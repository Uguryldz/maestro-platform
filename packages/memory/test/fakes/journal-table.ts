import type { JournalEntry } from "@maestro/contracts";
import { SeqTakenError } from "../../src/errors.js";
import type { JournalStore } from "../../src/types.js";

/**
 * One "table". Several `JournalStore`s over the same table stand in for
 * several processes writing the same run — which is the case the sequence
 * allocation has to survive, since the in-process write chain cannot help
 * there.
 */
export class JournalTable {
  readonly rows = new Map<string, JournalEntry>();

  private static id(runId: string, seq: number): string {
    return `${runId}#${seq}`;
  }

  /** The primary key, enforced exactly as Postgres would. */
  insert(entry: JournalEntry): void {
    const id = JournalTable.id(entry.runId, entry.seq);
    if (this.rows.has(id)) throw new SeqTakenError(entry.runId, entry.seq);
    this.rows.set(id, entry);
  }

  of(runId: string): JournalEntry[] {
    return [...this.rows.values()]
      .filter((row) => row.runId === runId)
      .sort((a, b) => a.seq - b.seq);
  }
}

export interface FakeStoreStats {
  reads: number;
  inserts: number;
  conflicts: number;
}

export interface FakeStoreOptions {
  /** Microtask yields inserted between read and write, to force interleaving. */
  readonly yields?: number;
}

async function tick(times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

export function fakeJournalStore(
  table: JournalTable,
  options: FakeStoreOptions = {},
): JournalStore & { readonly stats: FakeStoreStats } {
  const stats: FakeStoreStats = { reads: 0, inserts: 0, conflicts: 0 };
  const yields = options.yields ?? 0;
  return {
    stats,
    async maxSeq(runId: string): Promise<number | null> {
      stats.reads += 1;
      await tick(yields);
      const rows = table.of(runId);
      return rows.length === 0 ? null : (rows[rows.length - 1] as JournalEntry).seq;
    },
    async insert(entry): Promise<void> {
      await tick(yields);
      try {
        table.insert(entry);
        stats.inserts += 1;
      } catch (error) {
        if (error instanceof SeqTakenError) stats.conflicts += 1;
        throw error;
      }
    },
    async list(runId: string, fromSeq?: number): Promise<JournalEntry[]> {
      await tick(yields);
      return table.of(runId).filter((row) => fromSeq === undefined || row.seq >= fromSeq);
    },
  };
}
