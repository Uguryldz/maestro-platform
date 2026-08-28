import type { ApplicationRecord, JournalEntry, RepoCard } from "@maestro/contracts";
import {
  decodeCursor,
  encodeCursor,
  type AppRegistry,
  type GateBoard,
  type GateFilter,
  type JournalFilter,
  type JournalReader,
  type OpenGate,
  type Page,
  type PageRequest,
} from "@maestro/bff";
import {
  toApplicationRecord,
  toJournalEntry,
  type ApplicationRow,
  type JournalEntryRow,
} from "@maestro/db";
import type { StepId, TicketKey } from "@maestro/contracts";
import { scopeWhere, type RunCatalogWhere } from "./read-runs.js";

/**
 * The journal, the gate board and the application registry, over Postgres.
 *
 * Grouped because they share one property worth stating once: each reads a
 * table that already exists and is already written by the worker, so none of
 * them invents a fact. Where a fact is genuinely absent (a gate's delegate, a
 * document's classification) it is reported as absent rather than filled in.
 */

// ── journal (M30) ─────────────────────────────────────────────────────────────

export interface JournalDelegate {
  findMany(args: {
    where: { runId: string; actor?: JournalEntry["actor"] };
    orderBy: { seq: "asc" };
    skip?: number;
    take?: number;
  }): Promise<JournalEntryRow[]>;
  count(args: { where: { runId: string; actor?: JournalEntry["actor"] } }): Promise<number>;
}

/**
 * The Postgres-backed `JournalReader` (M30).
 *
 * Append-only upstream (a trigger enforces it, migration 0002), so paging by
 * offset is stable here in a way it is not for a mutable table: an entry never
 * moves, and a page boundary therefore never skips one.
 */
export class PrismaJournalReader implements JournalReader {
  constructor(private readonly journal: JournalDelegate) {}

  async list(runId: string, filter: JournalFilter): Promise<Page<JournalEntry>> {
    const where = { runId, ...(filter.actor === null ? {} : { actor: filter.actor }) };
    const fingerprint = `journal:${runId}:${filter.actor ?? ""}`;
    const offset = decodeCursor(filter.cursor, fingerprint);

    const rows = await this.journal.findMany({
      where,
      orderBy: { seq: "asc" },
      skip: offset,
      take: filter.limit,
    });
    const total = await this.journal.count({ where });
    const next = offset + rows.length;

    return {
      items: rows.map(toJournalEntry),
      nextCursor: next < total ? encodeCursor(next, fingerprint) : null,
    };
  }

  /**
   * The living summary (M30).
   *
   * There is no summary column and no summary table: the summary is
   * regenerated from the journal by `@maestro/memory`, and nothing persists
   * the generated text. `null` is the honest answer — the interface documents
   * it as "the run has produced none", and this deployment has produced none
   * because nothing writes one. Synthesising one here by concatenating entry
   * titles would put text on a bank's screen that no summariser ever wrote.
   */
  summary(_runId: string): Promise<string | null> {
    return Promise.resolve(null);
  }
}

// ── gates (M71/M101) ──────────────────────────────────────────────────────────

/** The `Gate` row joined to the run that owns it. */
export interface GateBoardRow {
  runId: string;
  step: string;
  ownerGroup: string;
  openedAt: Date;
  run: { ticketKey: string } | null;
}

export interface GateBoardWhere {
  closedAt: null;
  ownerGroup?: string;
  run?: RunCatalogWhere;
}

export interface GateBoardDelegate {
  findMany(args: {
    where: GateBoardWhere;
    orderBy: { openedAt: "asc" };
    include: { run: { select: { ticketKey: true } } };
    skip?: number;
    take?: number;
  }): Promise<GateBoardRow[]>;
  count(args: { where: GateBoardWhere }): Promise<number>;
}

/**
 * The Postgres-backed `GateBoard` (M88) — what is waiting on a human.
 *
 * `closedAt: null` IS the definition of open, and it is a `WHERE` rather than
 * a filter over a fetched page for the same reason the project scope is: a
 * board that fetched 50 rows and then dropped the closed ones would show a
 * short page and call it the queue.
 *
 * The project scope reaches through the relation to the run's ticket key,
 * because a gate has no project of its own — it belongs to the run's.
 */
export class PrismaGateBoard implements GateBoard {
  constructor(private readonly gates: GateBoardDelegate) {}

  async listOpen(filter: GateFilter): Promise<Page<OpenGate>> {
    const scope = scopeWhere(filter.projectKeys);
    const where: GateBoardWhere = {
      closedAt: null,
      ...(filter.ownerGroup === null ? {} : { ownerGroup: filter.ownerGroup }),
      ...(Object.keys(scope).length === 0 ? {} : { run: scope }),
    };
    const fingerprint = `gates:${filter.ownerGroup ?? ""}`;
    const offset = decodeCursor(filter.cursor, fingerprint);

    const rows = await this.gates.findMany({
      where,
      orderBy: { openedAt: "asc" },
      include: { run: { select: { ticketKey: true } } },
      skip: offset,
      take: filter.limit,
    });
    const total = await this.gates.count({ where });
    const next = offset + rows.length;

    return {
      items: rows.map(toOpenGate),
      nextCursor: next < total ? encodeCursor(next, fingerprint) : null,
    };
  }
}

/**
 * Row -> `OpenGate`.
 *
 * `delegatedTo` is the escalation ladder's current addressee (M45). The `Gate`
 * table records which ladder STEPS have fired (`firedStepIds`) but not who
 * each one reached — the addressee is resolved from the notification config at
 * send time and never written back. `null` is therefore the truth: this gate
 * has no recorded delegate. Reporting the owner group here instead would tell
 * an operator the gate had been escalated to the group it started with.
 */
function toOpenGate(row: GateBoardRow): OpenGate {
  return {
    ticketKey: (row.run?.ticketKey ?? "") as TicketKey,
    runId: row.runId,
    step: row.step as StepId,
    ownerGroup: row.ownerGroup,
    openedAt: row.openedAt.toISOString(),
    delegatedTo: null,
  };
}

// ── application registry + repo cards (M100) ──────────────────────────────────

export interface AppRegistryDelegate {
  findUnique(args: { where: { appId: string } }): Promise<ApplicationRow | null>;
  findMany(args: {
    orderBy: { appId: "asc" };
    skip?: number;
    take?: number;
  }): Promise<ApplicationRow[]>;
  count(): Promise<number>;
}

/** The newest `RepoCard` version for an app. */
export interface RepoCardRow {
  appId: string;
  version: number;
  modulesJson: unknown;
  generatedFromSha: string;
  updatedAt: Date;
}

export interface RepoCardDelegate {
  findFirst(args: {
    where: { appId: string };
    orderBy: { version: "desc" };
  }): Promise<RepoCardRow | null>;
}

/**
 * The Postgres-backed `AppRegistry` (M100).
 *
 * Unscoped by project, matching the route: the registry is readable by any
 * authenticated session by design, because an analyst judging cross-app impact
 * needs to see the applications they do not work on.
 */
export class PrismaAppRegistry implements AppRegistry {
  constructor(
    private readonly apps: AppRegistryDelegate,
    private readonly cards: RepoCardDelegate,
  ) {}

  async get(appId: string): Promise<ApplicationRecord | null> {
    const row = await this.apps.findUnique({ where: { appId } });
    return row === null ? null : toApplicationRecord(row);
  }

  async list(page: PageRequest): Promise<Page<ApplicationRecord>> {
    const fingerprint = "apps";
    const offset = decodeCursor(page.cursor, fingerprint);

    const rows = await this.apps.findMany({
      orderBy: { appId: "asc" },
      skip: offset,
      take: page.limit,
    });
    const total = await this.apps.count();
    const next = offset + rows.length;

    return {
      items: rows.map(toApplicationRecord),
      nextCursor: next < total ? encodeCursor(next, fingerprint) : null,
    };
  }

  /**
   * The newest repo card for an app (M100).
   *
   * Versioned by `(appId, version)` and never overwritten, so "the card" means
   * the highest version. `null` when none was ever generated, which the
   * interface names explicitly — a card with no modules would fail the
   * contract's `min(1)` anyway, so an empty one is not even expressible.
   */
  async repoCard(appId: string): Promise<RepoCard | null> {
    const row = await this.cards.findFirst({ where: { appId }, orderBy: { version: "desc" } });
    if (row === null) return null;
    return {
      appId: row.appId as RepoCard["appId"],
      modules: row.modulesJson as RepoCard["modules"],
      generatedFromSha: row.generatedFromSha,
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
