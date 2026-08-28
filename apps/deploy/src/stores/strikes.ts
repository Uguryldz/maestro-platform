import type { StrikeKey, StrikeRecord, StrikeStore } from "@maestro/execution";

/**
 * Postgres-backed `StrikeStore` (M54).
 *
 * Lives here rather than in `@maestro/execution` for the same reason the six
 * run-scoped stores live here: that package declares the interface and must
 * not import Prisma, which is what keeps its tests offline against fakes. The
 * composition root is the one place allowed to know both sides.
 *
 * The rows are derived state, not a record of a human decision — which is why
 * the foreign key cascades and why `remove` is a plain delete: a counter that
 * was cleared has served its purpose and re-reading it would restart a ladder
 * the run already climbed out of.
 */

/** One row, as Prisma returns it. `reasons` is a text[]. */
export interface StrikeCounterRow {
  runId: string;
  scope: string;
  ref: string;
  count: number;
  firstAt: Date;
  lastAt: Date;
  reasons: string[];
}

type StrikeWhere = { runId_scope_ref: { runId: string; scope: string; ref: string } };

export interface StrikeCounterDelegate {
  findMany(args: { where: { runId: string } }): Promise<StrikeCounterRow[]>;
  upsert(args: {
    where: StrikeWhere;
    create: StrikeCounterRow;
    update: { count: number; lastAt: Date; reasons: string[] };
  }): Promise<unknown>;
  delete(args: { where: StrikeWhere }): Promise<unknown>;
}

export class PrismaStrikeStore implements StrikeStore {
  constructor(private readonly counters: StrikeCounterDelegate) {}

  async load(runId: string): Promise<readonly StrikeRecord[]> {
    const rows = await this.counters.findMany({ where: { runId } });
    return rows.map((row) => ({
      runId: row.runId,
      scope: row.scope,
      ref: row.ref,
      count: row.count,
      firstAt: row.firstAt.toISOString(),
      lastAt: row.lastAt.toISOString(),
      reasons: row.reasons,
    }));
  }

  /**
   * Upsert rather than insert-or-update in two steps.
   *
   * The ledger writes behind the turn, and two workers retrying the same
   * activity can both reach this line. `upsert` settles that inside one
   * statement; a `SELECT` followed by an `INSERT` is the race itself.
   *
   * `firstAt` is deliberately absent from the UPDATE branch: it records when
   * the counter opened, and a retry that reset it would make the handover note
   * claim the run got stuck later than it did.
   */
  async save(record: StrikeRecord): Promise<void> {
    const reasons = [...record.reasons];
    await this.counters.upsert({
      where: { runId_scope_ref: { runId: record.runId, scope: record.scope, ref: record.ref } },
      create: {
        runId: record.runId,
        scope: record.scope,
        ref: record.ref,
        count: record.count,
        firstAt: new Date(record.firstAt),
        lastAt: new Date(record.lastAt),
        reasons,
      },
      update: { count: record.count, lastAt: new Date(record.lastAt), reasons },
    });
  }

  /**
   * Clearing a counter that was never written is not an error.
   *
   * `AgentExecution` clears the protected-path key on every clean turn, and
   * the overwhelmingly common case is that no such row exists. Prisma raises
   * P2025 for that, and letting it through would turn every successful turn's
   * cleanup into a logged write failure.
   */
  async remove(key: StrikeKey): Promise<void> {
    await this.counters
      .delete({ where: { runId_scope_ref: { runId: key.runId, scope: key.scope, ref: key.ref } } })
      .catch(() => undefined);
  }
}
