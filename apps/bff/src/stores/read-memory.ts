import type {
  ApplicationRecord,
  AuditEvent,
  EvidencePackage,
  JournalEntry,
  LlmCallLog,
  RepoCard,
  SubscriptionAccount,
} from "@maestro/contracts";
import type { AuditStore } from "@maestro/audit";
import { verifyChain } from "@maestro/audit";
import type {
  AppRegistry,
  ArchiveScope,
  AuditFilter,
  AuditReader,
  CostFilter,
  CostReader,
  EvidenceReader,
  GateBoard,
  GateFilter,
  HealthReader,
  JournalFilter,
  JournalReader,
  KnowledgeDoc,
  KnowledgeIndex,
  KnowledgeQuery,
  OpenGate,
  Page,
  PageRequest,
  QuotaReader,
  RunCatalog,
  RunCatalogFilter,
  RunRecord,
  RunnerFleet,
  RunnerRecord,
  SandboxRecord,
  ScanFilter,
  ScanReader,
  ScanRecord,
  ServiceHealth,
} from "../read-models.js";
import { filterAuditEvents } from "../audit-filter.js";
import { inScope, paginate } from "./cursor.js";
export { decodeCursor, encodeCursor, paginate } from "./cursor.js";

/**
 * Reference implementations of the read side, in the spirit of
 * `InMemoryParamStore`: they enforce the same bounds the database-backed ones
 * must — a cursor that survives a filter change, a page that never exceeds the
 * limit — so a paging bug shows up here rather than in production. The dev
 * compose and the tests use them; Postgres-backed versions replace them behind
 * the same interfaces.
 */

export class InMemoryRunCatalog implements RunCatalog {
  private readonly rows = new Map<string, RunRecord>();

  constructor(records: readonly RunRecord[] = []) {
    for (const record of records) this.put(record);
  }

  put(record: RunRecord): void {
    this.rows.set(record.ticketKey, { ...record });
  }

  get(ticketKey: string): Promise<RunRecord | null> {
    return Promise.resolve(this.rows.get(ticketKey) ?? null);
  }

  list(filter: RunCatalogFilter): Promise<Page<RunRecord>> {
    const rows = [...this.rows.values()]
      .filter((row) => inScope(row.ticketKey, filter.projectKeys))
      .filter((row) => filter.appId === null || row.appId === filter.appId)
      // The same three-way scope `archiveWhere` builds in SQL (0019). It is
      // applied BEFORE `paginate` for the reason the whole store exists: a page
      // of `limit` rows must be a page of rows the caller asked for, and a
      // filter applied after slicing would shorten pages at random.
      .filter((row) => matchesArchiveScope(row, filter.archived))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    // Fingerprinted with the archive scope, exactly as `PrismaRunCatalog` does,
    // so a cursor issued against the board is rejected by the archived view
    // rather than silently resuming at the wrong offset.
    return Promise.resolve(
      paginate(rows, filter, `runs:${filter.appId ?? ""}:${filter.archived}`),
    );
  }

  /**
   * The one write (0019). Mirrors the Prisma store: `false` means no such
   * ticket (a 404 for the route), while archiving an already-archived run
   * succeeds as an idempotent no-op rather than reporting a false absence.
   */
  setArchived(ticketKey: string, at: Date | null): Promise<boolean> {
    const row = this.rows.get(ticketKey);
    if (row === undefined) return Promise.resolve(false);
    this.rows.set(ticketKey, { ...row, archivedAt: at === null ? null : at.toISOString() });
    return Promise.resolve(true);
  }
}

/** @see RunCatalogFilter.archived — the in-memory half of `archiveWhere`. */
function matchesArchiveScope(row: RunRecord, scope: ArchiveScope): boolean {
  if (scope === "all") return true;
  return scope === "active" ? row.archivedAt === null : row.archivedAt !== null;
}

export class InMemoryJournalReader implements JournalReader {
  private readonly entries = new Map<string, JournalEntry[]>();
  private readonly summaries = new Map<string, string>();

  append(entry: JournalEntry): void {
    const list = this.entries.get(entry.runId) ?? [];
    list.push({ ...entry });
    list.sort((left, right) => left.seq - right.seq);
    this.entries.set(entry.runId, list);
  }

  putSummary(runId: string, text: string): void {
    this.summaries.set(runId, text);
  }

  list(runId: string, filter: JournalFilter): Promise<Page<JournalEntry>> {
    const rows = (this.entries.get(runId) ?? []).filter(
      (entry) => filter.actor === null || entry.actor === filter.actor,
    );
    return Promise.resolve(paginate(rows, filter, `journal:${runId}:${filter.actor ?? ""}`));
  }

  summary(runId: string): Promise<string | null> {
    return Promise.resolve(this.summaries.get(runId) ?? null);
  }
}

export class InMemoryGateBoard implements GateBoard {
  private readonly gates: OpenGate[] = [];

  open(gate: OpenGate): void {
    this.gates.push({ ...gate });
  }

  close(ticketKey: string, step: string): void {
    const index = this.gates.findIndex(
      (gate) => gate.ticketKey === ticketKey && gate.step === step,
    );
    if (index >= 0) this.gates.splice(index, 1);
  }

  listOpen(filter: GateFilter): Promise<Page<OpenGate>> {
    const rows = this.gates
      .filter((gate) => inScope(gate.ticketKey, filter.projectKeys))
      .filter((gate) => filter.ownerGroup === null || gate.ownerGroup === filter.ownerGroup)
      .sort((left, right) => left.openedAt.localeCompare(right.openedAt));
    return Promise.resolve(paginate(rows, filter, `gates:${filter.ownerGroup ?? ""}`));
  }
}

export class InMemoryAppRegistry implements AppRegistry {
  private readonly apps = new Map<string, ApplicationRecord>();
  private readonly cards = new Map<string, RepoCard>();

  constructor(apps: readonly ApplicationRecord[] = []) {
    for (const app of apps) this.put(app);
  }

  put(app: ApplicationRecord): void {
    this.apps.set(app.appId, { ...app });
  }

  putRepoCard(card: RepoCard): void {
    this.cards.set(card.appId, { ...card });
  }

  get(appId: string): Promise<ApplicationRecord | null> {
    return Promise.resolve(this.apps.get(appId) ?? null);
  }

  list(page: PageRequest): Promise<Page<ApplicationRecord>> {
    const rows = [...this.apps.values()].sort((left, right) =>
      left.appId.localeCompare(right.appId),
    );
    return Promise.resolve(paginate(rows, page, "apps"));
  }

  repoCard(appId: string): Promise<RepoCard | null> {
    return Promise.resolve(this.cards.get(appId) ?? null);
  }
}

export class InMemoryKnowledgeIndex implements KnowledgeIndex {
  private readonly docs: KnowledgeDoc[] = [];

  constructor(docs: readonly KnowledgeDoc[] = []) {
    for (const doc of docs) this.put(doc);
  }

  put(doc: KnowledgeDoc): void {
    this.docs.push({ ...doc });
  }

  search(query: KnowledgeQuery): Promise<Page<KnowledgeDoc>> {
    const needle = query.text.toLowerCase();
    const rows = this.docs
      .filter((doc) => query.appId === null || doc.appId === query.appId)
      .filter(
        (doc) =>
          doc.title.toLowerCase().includes(needle) || doc.snippet.toLowerCase().includes(needle),
      )
      .sort((left, right) => right.score - left.score);
    return Promise.resolve(paginate(rows, query, `knowledge:${needle}:${query.appId ?? ""}`));
  }
}

export class InMemoryRunnerFleet implements RunnerFleet {
  private readonly runners: RunnerRecord[] = [];
  private readonly boxes: SandboxRecord[] = [];

  constructor(runners: readonly RunnerRecord[] = []) {
    for (const runner of runners) this.put(runner);
  }

  put(runner: RunnerRecord): void {
    this.runners.push({ ...runner });
  }

  putSandbox(box: SandboxRecord): void {
    this.boxes.push({ ...box });
  }

  list(page: PageRequest): Promise<Page<RunnerRecord>> {
    return Promise.resolve(paginate([...this.runners], page, "runners"));
  }

  sandboxes(page: PageRequest): Promise<Page<SandboxRecord>> {
    return Promise.resolve(paginate([...this.boxes], page, "sandboxes"));
  }
}

export class InMemoryQuotaReader implements QuotaReader {
  constructor(private readonly pool: readonly SubscriptionAccount[] = []) {}

  accounts(): Promise<readonly SubscriptionAccount[]> {
    return Promise.resolve(this.pool.map((account) => ({ ...account })));
  }
}

export class InMemoryCostReader implements CostReader {
  private readonly rows: LlmCallLog[] = [];

  constructor(calls: readonly LlmCallLog[] = []) {
    for (const call of calls) this.put(call);
  }

  put(call: LlmCallLog): void {
    this.rows.push({ ...call });
  }

  calls(filter: CostFilter): Promise<Page<LlmCallLog>> {
    const rows = this.rows
      .filter((row) => filter.runId === null || row.runId === filter.runId)
      .sort((left, right) => right.at.localeCompare(left.at));
    return Promise.resolve(paginate(rows, filter, `cost:${filter.runId ?? ""}`));
  }
}

export class InMemoryScanReader implements ScanReader {
  private readonly rows: ScanRecord[] = [];

  constructor(records: readonly ScanRecord[] = []) {
    for (const record of records) this.put(record);
  }

  put(record: ScanRecord): void {
    this.rows.push({ ...record });
  }

  list(filter: ScanFilter): Promise<Page<ScanRecord>> {
    const rows = this.rows
      .filter((row) => inScope(row.ticketKey, filter.projectKeys))
      .sort((left, right) => right.at.localeCompare(left.at));
    return Promise.resolve(paginate(rows, filter, "scans"));
  }
}

export class InMemoryEvidenceReader implements EvidenceReader {
  private readonly packages = new Map<string, EvidencePackage>();

  put(pkg: EvidencePackage): void {
    this.packages.set(pkg.runId, { ...pkg });
  }

  get(runId: string): Promise<EvidencePackage | null> {
    return Promise.resolve(this.packages.get(runId) ?? null);
  }
}

/**
 * The query side of the trail, reading the SAME store the chain appends to
 * (M33). Sharing the store rather than keeping a copy is what makes the
 * verification meaningful: a reader with its own list would verify itself.
 */
export class AuditStoreReader implements AuditReader {
  constructor(private readonly store: AuditStore) {}

  async list(filter: AuditFilter): Promise<Page<AuditEvent>> {
    const events = await this.store.read();
    // The B13 filter semantics live in audit-filter.ts so the JSON page and the
    // CSV export can never disagree about what "matches".
    const rows = filterAuditEvents(events, filter).sort((left, right) => right.seq - left.seq);
    const fingerprint = [
      "audit",
      filter.actor ?? "",
      filter.subject ?? "",
      filter.from ?? "",
      filter.to ?? "",
      filter.action ?? "",
      filter.q ?? "",
    ].join(":");
    return paginate(rows, filter, fingerprint);
  }

  async verify(): Promise<{ ok: boolean; checked: number; brokenAtSeq: number | null }> {
    const events = await this.store.read();
    // No `expectFirstSeq`: the default (seq 1 from genesis) is the only
    // trustworthy expectation, and an emptied table reports `ok: false` —
    // emptiness proves nothing about a chain.
    const result = verifyChain(events);
    return { ok: result.ok, checked: result.checked, brokenAtSeq: result.firstBadSeq };
  }
}

export class StaticHealthReader implements HealthReader {
  constructor(private readonly rows: readonly ServiceHealth[] = []) {}

  services(): Promise<readonly ServiceHealth[]> {
    return Promise.resolve(this.rows.map((row) => ({ ...row })));
  }
}
