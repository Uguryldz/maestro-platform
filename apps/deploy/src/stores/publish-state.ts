import type { PublishStateStore } from "@maestro/publish";

/**
 * The Postgres-backed `PublishStateStore` (M47/M75).
 *
 * The publisher remembers what it already posted — "the analysis for PAY-101
 * is comment 4711, content hash abc" — so a republish EDITS that comment
 * instead of adding another one. `InMemoryPublishState` loses that memory on
 * every restart, and the next publish then posts a duplicate to a bank's
 * ticket. That is why the composition root refused to build `PublishDeps`
 * without this store rather than falling back to the in-memory one.
 *
 * The value is opaque text on purpose: each driver stores its own shape (a
 * Confluence page id, a JSON `{commentId, hash}`), and parsing it here would
 * make this store know about drivers it must not know about.
 */

export interface PublishStateRow {
  key: string;
  value: string;
}

export interface PublishStateDelegate {
  findUnique(args: { where: { key: string } }): Promise<PublishStateRow | null>;
  upsert(args: {
    where: { key: string };
    create: { key: string; value: string; updatedAt: Date };
    update: { value: string; updatedAt: Date };
  }): Promise<unknown>;
}

export class PrismaPublishState implements PublishStateStore {
  constructor(
    private readonly rows: PublishStateDelegate,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * A missing key is `null`, not an error — and this is the one store in the
   * set where that is right. "I have never published this document" is the
   * normal first-publish case, and the caller's whole job is to distinguish it
   * from "I published it as comment 4711". Throwing would make the first
   * publish of every document a failure.
   */
  async get(key: string): Promise<string | null> {
    const row = await this.rows.findUnique({ where: { key } });
    return row === null ? null : row.value;
  }

  /**
   * Upsert rather than insert: republishing the same document with new content
   * overwrites the recorded hash, which is exactly the point — the receipt
   * tracks the LATEST publish, and an insert would fail on the second one.
   */
  async set(key: string, value: string): Promise<void> {
    const at = this.now();
    await this.rows.upsert({
      where: { key },
      create: { key, value, updatedAt: at },
      update: { value, updatedAt: at },
    });
  }
}
