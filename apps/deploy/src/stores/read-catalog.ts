import type { EvidencePackage, LlmCallLog, SubscriptionAccount } from "@maestro/contracts";
import {
  decodeCursor,
  encodeCursor,
  UNLABELLED_CLASS,
  type CostFilter,
  type CostReader,
  type EvidenceReader,
  type KnowledgeDoc,
  type KnowledgeIndex,
  type KnowledgeQuery,
  type Page,
  type QuotaReader,
} from "@maestro/bff";
import { toEvidencePackage, toLlmCallLog, type LlmCallRow } from "@maestro/db";

/**
 * Knowledge, quota, cost and evidence, over Postgres.
 *
 * The interesting one is `knowledge`: the table it reads has no `dataClass`
 * column, and the read model requires one. That is not a reason to guess — see
 * `PrismaKnowledgeIndex` for why every document comes back `gizli`.
 */

// ── knowledge (M18/M63) ───────────────────────────────────────────────────────

export interface KnowledgeDocRow {
  id: string;
  kind: string;
  title: string;
  version: number;
  contentRef: string;
  updatedAt: Date;
}

export interface KnowledgeWhere {
  title?: { contains: string; mode: "insensitive" };
}

export interface KnowledgeDelegate {
  findMany(args: {
    where: KnowledgeWhere;
    orderBy: [{ updatedAt: "desc" }, { version: "desc" }];
    skip?: number;
    take?: number;
  }): Promise<KnowledgeDocRow[]>;
  count(args: { where: KnowledgeWhere }): Promise<number>;
}

/**
 * The Postgres-backed `KnowledgeIndex` (M18/M63).
 *
 * Three honest limitations, each reported rather than papered over:
 *
 *  1. **`dataClass` is `gizli` for every document.** The `KnowledgeDoc` table
 *     has no classification column, and the interface says an index that
 *     cannot classify a document MUST report `gizli` — "an unlabelled
 *     confidential file read as `dahili` is exactly how one leaves the
 *     building". So this is not a degradation to work around: it is the
 *     specified behaviour for an unlabelled corpus, and it is fail-closed.
 *     The BFF's `visibleKnowledge` then withholds these from anyone without
 *     the `maestro-gizli` clearance and TELLS them how many were withheld, so
 *     a cleared auditor still reads the corpus and nobody else silently does.
 *
 *  2. **It is a title match, not a vector search.** There is no embedding
 *     column and no vector store driver, so `score` is not a relevance score
 *     anyone computed. Rather than invent one, every hit scores 0 and results
 *     are ordered by recency — a stable, explicable order. A fabricated 0.93
 *     would be read as confidence.
 *
 *  3. **`appId` cannot be filtered.** The table has no application column.
 *     A query that names an app is answered with the whole corpus rather than
 *     an empty page: the documents ARE candidates, and returning nothing would
 *     tell the caller the knowledge base is empty for that app when it is
 *     simply not partitioned by app.
 */
export class PrismaKnowledgeIndex implements KnowledgeIndex {
  constructor(private readonly docs: KnowledgeDelegate) {}

  async search(query: KnowledgeQuery): Promise<Page<KnowledgeDoc>> {
    const needle = query.text.trim();
    const where: KnowledgeWhere =
      needle.length === 0 ? {} : { title: { contains: needle, mode: "insensitive" } };
    // The in-memory index fingerprints on the lowercased needle and the app;
    // matching it keeps a cursor meaning the same thing across both.
    const fingerprint = `knowledge:${needle.toLowerCase()}:${query.appId ?? ""}`;
    const offset = decodeCursor(query.cursor, fingerprint);

    const rows = await this.docs.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { version: "desc" }],
      skip: offset,
      take: query.limit,
    });
    const total = await this.docs.count({ where });
    const next = offset + rows.length;

    return {
      items: rows.map(toKnowledgeDoc),
      nextCursor: next < total ? encodeCursor(next, fingerprint) : null,
    };
  }
}

/**
 * Row -> `KnowledgeDoc`.
 *
 * `snippet` is the storage key rather than the document's text: the text lives
 * behind the storage port and this store does not fetch it. Naming the key is
 * checkable; inventing a summary of a file we did not read is not.
 */
export function toKnowledgeDoc(row: KnowledgeDocRow): KnowledgeDoc {
  return {
    id: `${row.id}@${row.version}`,
    title: row.title,
    snippet: row.contentRef,
    source: row.kind,
    score: 0,
    dataClass: UNLABELLED_CLASS,
    appId: null,
    // The table records no author; "" is the absent value the record uses
    // elsewhere, and a plausible name here would be a false attribution.
    updatedBy: "",
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ── quota (M55) ───────────────────────────────────────────────────────────────

export interface SubscriptionAccountRow {
  accountId: string;
  driver: string;
  state: SubscriptionAccount["state"];
  windowsJson: unknown;
  lastUsedAt: Date | null;
}

export interface QuotaDelegate {
  findMany(args: { orderBy: { accountId: "asc" } }): Promise<SubscriptionAccountRow[]>;
}

/**
 * The Postgres-backed `QuotaReader` (M55).
 *
 * Unpaged by interface: the subscription pool is a handful of accounts an
 * operator reads whole, and a cursor over five rows would be ceremony. The
 * pool is small because it is a list of purchased seats, not a log.
 */
export class PrismaQuotaReader implements QuotaReader {
  constructor(private readonly accountsDelegate: QuotaDelegate) {}

  async accounts(): Promise<readonly SubscriptionAccount[]> {
    const rows = await this.accountsDelegate.findMany({ orderBy: { accountId: "asc" } });
    return rows.map((row) => ({
      accountId: row.accountId,
      driver: row.driver as SubscriptionAccount["driver"],
      windows: row.windowsJson as SubscriptionAccount["windows"],
      state: row.state,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    }));
  }
}

// ── cost (M16) ────────────────────────────────────────────────────────────────

export interface CostWhere {
  runId?: string;
}

export interface CostDelegate {
  findMany(args: {
    where: CostWhere;
    orderBy: { at: "desc" };
    skip?: number;
    take?: number;
  }): Promise<LlmCallRow[]>;
  count(args: { where: CostWhere }): Promise<number>;
}

/**
 * The Postgres-backed `CostReader` (M16) — the gateway call log.
 *
 * `runId` is the only filter, and the route never takes it from the query
 * string: per-run it is resolved from a ticket the caller has been authorised
 * for, and the platform-wide view is `null` behind an ops role. So this store
 * does not re-check access; it answers exactly the question it was asked.
 */
export class PrismaCostReader implements CostReader {
  constructor(private readonly log: CostDelegate) {}

  async calls(filter: CostFilter): Promise<Page<LlmCallLog>> {
    const where: CostWhere = filter.runId === null ? {} : { runId: filter.runId };
    const fingerprint = `cost:${filter.runId ?? ""}`;
    const offset = decodeCursor(filter.cursor, fingerprint);

    const rows = await this.log.findMany({
      where,
      orderBy: { at: "desc" },
      skip: offset,
      take: filter.limit,
    });
    const total = await this.log.count({ where });
    const next = offset + rows.length;

    return {
      items: rows.map(toLlmCallLog),
      nextCursor: next < total ? encodeCursor(next, fingerprint) : null,
    };
  }
}

// ── evidence (M56) ────────────────────────────────────────────────────────────

export interface EvidenceDelegate {
  findFirst(args: {
    where: { runId: string };
    orderBy: { createdAt: "desc" };
  }): Promise<{ manifestJson: unknown } | null>;
}

/**
 * The Postgres-backed `EvidenceReader` (M56).
 *
 * The manifest only. The files it lists stay behind the storage port with
 * their own signed URLs, so this never becomes a way to stream a bank's
 * evidence archive through the API process.
 */
export class PrismaEvidenceReader implements EvidenceReader {
  constructor(private readonly packages: EvidenceDelegate) {}

  async get(runId: string): Promise<EvidencePackage | null> {
    const row = await this.packages.findFirst({
      where: { runId },
      orderBy: { createdAt: "desc" },
    });
    return row === null ? null : toEvidencePackage(row);
  }
}
