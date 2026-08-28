import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "@maestro/bff";
import {
  archiveWhere,
  parentOf,
  PrismaRunCatalog,
  scopeWhere,
  toRunRecord,
  type RunCatalogDelegate,
  type RunCatalogRow,
  type RunCatalogWhere,
  type RunCostDelegate,
} from "../src/stores/read-runs.js";
import { toKnowledgeDoc } from "../src/stores/read-catalog.js";
import {
  foldSandboxes,
  PrismaSandboxReader,
  sandboxIdentity,
  type SandboxAuditRow,
} from "../src/stores/read-sandbox.js";
import { ProbeHealthReader, safeNote, type ServiceProbe } from "../src/stores/read-health.js";
import { liveReadModels } from "../src/stores/read-live.js";
import { UNBACKED_READ_MODELS } from "../src/stores/read-models.js";

/**
 * The read side's logic, against fakes that enforce what the database enforces.
 *
 * The properties worth testing here are the ones a wrong implementation gets
 * wrong silently: a project scope that is applied AFTER the page (so the page
 * comes back short), a cursor that restarts instead of continuing, a total
 * that counts rows the caller may not see. Each of those renders as a plausible
 * screen, which is why they are asserted rather than eyeballed.
 */

/**
 * A `WorkflowRun` fake that applies the store's `WHERE` the way Postgres does:
 * the scope narrows the set BEFORE the offset and the count, so `count` and
 * `findMany` always agree about which rows exist.
 */
function fakeRuns(rows: RunCatalogRow[]): RunCatalogDelegate & { queries: RunCatalogWhere[] } {
  const queries: RunCatalogWhere[] = [];
  const matching = (where: RunCatalogWhere): RunCatalogRow[] => {
    queries.push(where);
    return rows
      .filter((row) => where.ticketKey === undefined || row.ticketKey === where.ticketKey)
      .filter((row) => where.appId === undefined || row.appId === where.appId)
      .filter(
        (row) =>
          where.OR === undefined ||
          where.OR.some((clause) => row.ticketKey.startsWith(clause.ticketKey.startsWith)),
      )
      // The archive clause (0019), honoured rather than ignored: a fake that
      // dropped it would let every archive test pass against a store that never
      // filtered, which is the one bug these tests exist to catch.
      .filter((row) => {
        if (where.archivedAt === undefined) return true;
        return where.archivedAt === null ? row.archivedAt === null : row.archivedAt !== null;
      })
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
  };
  return {
    queries,
    findMany: (args) => {
      const found = matching(args.where);
      const from = args.skip ?? 0;
      return Promise.resolve(found.slice(from, from + (args.take ?? found.length)));
    },
    count: (args) => Promise.resolve(matching(args.where).length),
    // Mutates the SAME row objects the reads above see, so an archive followed
    // by a list is a genuine round trip rather than two independent fakes
    // agreeing by construction.
    updateMany: (args) => {
      const found = matching(args.where);
      for (const row of found) row.archivedAt = args.data.archivedAt;
      return Promise.resolve({ count: found.length });
    },
  };
}

const noCosts: RunCostDelegate = { groupBy: () => Promise.resolve([]) };

function run(ticketKey: string, updatedAt: string, extra: Partial<RunCatalogRow> = {}): RunCatalogRow {
  return {
    id: `run-${ticketKey.toLowerCase()}`,
    ticketKey,
    appId: "ugurpay",
    mode: "full_auto",
    risk: "orta",
    dataClass: "dahili",
  step: "3",
    status: "running",
    prId: null,
    matchJson: { via: "rule", ruleId: "rule-1", appId: "ugurpay" },
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date(updatedAt),
    // On the board unless a test says otherwise (0019).
    archivedAt: null,
    ...extra,
  };
}

describe("run catalog: project scope is a WHERE, not a post-filter", () => {
  it("never returns a run outside the caller's projects", async () => {
    const runs = fakeRuns([
      run("UGURPAY-1", "2026-01-03T00:00:00.000Z"),
      run("UGURWEB-2", "2026-01-02T00:00:00.000Z"),
      run("UGURMOB-3", "2026-01-01T00:00:00.000Z"),
    ]);
    const catalog = new PrismaRunCatalog(runs, noCosts);

    const page = await catalog.list({
      limit: 50,
      cursor: null,
      appId: null,
      projectKeys: ["UGURPAY"],
      archived: "all",
    });

    expect(page.items.map((item) => item.ticketKey)).toEqual(["UGURPAY-1"]);
  });

  it("fills a full page from the caller's own projects rather than shortening it", async () => {
    // Ten rows, only five visible. A store that paged first and filtered after
    // would return two of them; the caller asked for five they may see.
    const rows = [
      ...Array.from({ length: 5 }, (_, i) =>
        run(`UGURPAY-${i}`, `2026-01-1${5 - i}T00:00:00.000Z`),
      ),
      ...Array.from({ length: 5 }, (_, i) => run(`OTHER-${i}`, `2026-01-2${i}T00:00:00.000Z`)),
    ];
    const catalog = new PrismaRunCatalog(fakeRuns(rows), noCosts);

    const page = await catalog.list({
      limit: 5,
      cursor: null,
      appId: null,
      projectKeys: ["UGURPAY"],
      archived: "all",
    });

    expect(page.items).toHaveLength(5);
    expect(page.items.every((item) => item.ticketKey.startsWith("UGURPAY-"))).toBe(true);
    // Nothing beyond the visible five, so no cursor promising a further page.
    expect(page.nextCursor).toBeNull();
  });

  it("an account in no project group sees nothing, not everything", async () => {
    const catalog = new PrismaRunCatalog(
      fakeRuns([run("UGURPAY-1", "2026-01-01T00:00:00.000Z")]),
      noCosts,
    );

    const page = await catalog.list({ limit: 50, cursor: null, appId: null, projectKeys: [], archived: "all" });

    expect(page.items).toEqual([]);
  });

  it("a cross-project role (null) sees every project", async () => {
    const catalog = new PrismaRunCatalog(
      fakeRuns([
        run("UGURPAY-1", "2026-01-02T00:00:00.000Z"),
        run("UGURWEB-2", "2026-01-01T00:00:00.000Z"),
      ]),
      noCosts,
    );

    const page = await catalog.list({ limit: 50, cursor: null, appId: null, projectKeys: null, archived: "all" });

    expect(page.items.map((item) => item.ticketKey)).toEqual(["UGURPAY-1", "UGURWEB-2"]);
  });

  it("scopes by whole key segment, so UGURPAY does not match UGURPAYMENTS", () => {
    // The clause is `startsWith("UGURPAY-")`, not `startsWith("UGURPAY")`.
    const where = scopeWhere(["UGURPAY"]);
    expect(where.OR).toEqual([{ ticketKey: { startsWith: "UGURPAY-" } }]);
  });
});

describe("run catalog: paging", () => {
  const rows = Array.from({ length: 7 }, (_, i) =>
    run(`UGURPAY-${i}`, `2026-01-0${7 - i}T00:00:00.000Z`),
  );

  it("walks the whole list exactly once and then stops", async () => {
    const catalog = new PrismaRunCatalog(fakeRuns(rows), noCosts);
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let guard = 0; guard < 10; guard += 1) {
      const page: Awaited<ReturnType<typeof catalog.list>> = await catalog.list({
        limit: 3,
        cursor,
        appId: null,
        projectKeys: null,
        archived: "all",
      });
      seen.push(...page.items.map((item) => item.ticketKey));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }

    expect(cursor).toBeNull();
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it("restarts rather than continuing when handed another query's cursor", async () => {
    const catalog = new PrismaRunCatalog(fakeRuns(rows), noCosts);

    // A cursor minted for a DIFFERENT filter (a different appId fingerprint).
    const foreign = encodeCursor(4, "runs:someone-elses-app");
    const page = await catalog.list({
      limit: 3,
      cursor: foreign,
      appId: null,
      projectKeys: null,
      archived: "all",
    });

    // Page one again — a silent skip in a work queue is a ticket nobody sees.
    expect(page.items.map((item) => item.ticketKey)).toEqual([
      "UGURPAY-0",
      "UGURPAY-1",
      "UGURPAY-2",
    ]);
  });

  it("ignores a garbage cursor instead of throwing", async () => {
    const catalog = new PrismaRunCatalog(fakeRuns(rows), noCosts);
    const page = await catalog.list({
      limit: 2,
      cursor: "not-a-cursor",
      appId: null,
      projectKeys: null,
      archived: "all",
    });
    expect(page.items).toHaveLength(2);
  });

  it("counts only rows inside the scope, so the cursor does not promise a page the caller cannot see", async () => {
    const catalog = new PrismaRunCatalog(
      fakeRuns([
        run("UGURPAY-1", "2026-01-03T00:00:00.000Z"),
        run("OTHER-1", "2026-01-02T00:00:00.000Z"),
        run("OTHER-2", "2026-01-01T00:00:00.000Z"),
      ]),
      noCosts,
    );

    const page = await catalog.list({
      limit: 1,
      cursor: null,
      appId: null,
      projectKeys: ["UGURPAY"],
      archived: "all",
    });

    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it("emits a cursor that decodes against its own fingerprint", async () => {
    const catalog = new PrismaRunCatalog(fakeRuns(rows), noCosts);
    const page = await catalog.list({ limit: 3, cursor: null, appId: null, projectKeys: null, archived: "all" });

    expect(page.nextCursor).not.toBeNull();
    // The fingerprint carries the archive scope (0019) as well as the appId:
    // the board and the archive are two different filtered sets, and a cursor
    // is an offset INTO one of them.
    expect(decodeCursor(page.nextCursor, "runs::all")).toBe(3);
  });

  /**
   * The reason the scope is in the fingerprint at all.
   *
   * A cursor is a plain offset. Without the scope in the fingerprint, one
   * issued against the active board would be accepted by the archived view and
   * silently SKIP that many archived rows — no error, just a page starting in
   * the wrong place, which is the answer-shaped-wrongness this file exists to
   * catch. With it, `decodeCursor` sees a fingerprint it did not write and
   * restarts at 0: the caller re-reads the first page rather than missing one.
   * Restarting is the safe direction, and it is only available because the
   * fingerprint can tell the two views apart at all.
   */
  it("does not let a board cursor skip rows in the archived view", async () => {
    const catalog = new PrismaRunCatalog(fakeRuns(rows), noCosts);
    const board = await catalog.list({
      limit: 3,
      cursor: null,
      appId: null,
      projectKeys: null,
      archived: "active",
    });

    expect(board.nextCursor).not.toBeNull();
    // Its own view continues where it left off …
    expect(decodeCursor(board.nextCursor, "runs::active")).toBe(3);
    // … and the other view refuses to honour it, falling back to the start.
    expect(decodeCursor(board.nextCursor, "runs::archived")).toBe(0);
  });
});

/**
 * Archiving (0019) at the STORE level.
 *
 * The property under test is not "the column can be written" — it is that a
 * run leaves the default view without leaving the database, and comes back on
 * request. Every assertion here is about a row that still exists.
 */
describe("run catalog: archiving hides a run from the board without deleting it", () => {
  const rows = (): RunCatalogRow[] => [
    run("UGURPAY-1", "2026-01-03T00:00:00.000Z"),
    run("UGURPAY-2", "2026-01-02T00:00:00.000Z"),
    run("UGURPAY-3", "2026-01-01T00:00:00.000Z"),
  ];
  const scope = { limit: 50, cursor: null, appId: null, projectKeys: null } as const;

  it("archives, hides from the default view, and un-archives — a full round trip", async () => {
    const store = fakeRuns(rows());
    const catalog = new PrismaRunCatalog(store, noCosts);

    expect(await catalog.setArchived("UGURPAY-2", new Date("2026-01-05T00:00:00.000Z"))).toBe(true);

    const active = await catalog.list({ ...scope, archived: "active" });
    expect(active.items.map((item) => item.ticketKey)).toEqual(["UGURPAY-1", "UGURPAY-3"]);

    // Still there — the whole point. A DELETE would pass the assertion above
    // and fail this one, which is why both are here.
    const archived = await catalog.list({ ...scope, archived: "archived" });
    expect(archived.items.map((item) => item.ticketKey)).toEqual(["UGURPAY-2"]);
    expect(archived.items[0]?.archivedAt).toBe("2026-01-05T00:00:00.000Z");

    // And back. Reversibility is the feature, not a nicety: an operator who
    // cannot undo will not archive at all.
    expect(await catalog.setArchived("UGURPAY-2", null)).toBe(true);
    const restored = await catalog.list({ ...scope, archived: "active" });
    expect(restored.items.map((item) => item.ticketKey)).toEqual([
      "UGURPAY-1",
      "UGURPAY-2",
      "UGURPAY-3",
    ]);
    expect(restored.items.every((item) => item.archivedAt === null)).toBe(true);
  });

  it("shows both sides under 'all', which is what an auditor asks for", async () => {
    const catalog = new PrismaRunCatalog(fakeRuns(rows()), noCosts);
    await catalog.setArchived("UGURPAY-2", new Date("2026-01-05T00:00:00.000Z"));

    const all = await catalog.list({ ...scope, archived: "all" });
    expect(all.items.map((item) => item.ticketKey)).toEqual([
      "UGURPAY-1",
      "UGURPAY-2",
      "UGURPAY-3",
    ]);
  });

  /**
   * The count and the list read the SAME `WHERE`. This is the tile-vs-list bug
   * in its store-level form: a `count` that ignored the archive clause would
   * make `nextCursor` promise a page of rows the filter had already removed,
   * and a dashboard tile reading "12" over a list showing none.
   */
  it("counts what it lists, so the cursor never promises a hidden row", async () => {
    const catalog = new PrismaRunCatalog(fakeRuns(rows()), noCosts);
    await catalog.setArchived("UGURPAY-2", new Date("2026-01-05T00:00:00.000Z"));

    // Two active rows and a limit of two: the page is exactly the set, so
    // there is no next page. A count over all three would emit a cursor.
    const page = await catalog.list({ ...scope, limit: 2, archived: "active" });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it("reports a missing ticket rather than claiming it archived one", async () => {
    const catalog = new PrismaRunCatalog(fakeRuns(rows()), noCosts);
    expect(await catalog.setArchived("NOSUCH-9", new Date())).toBe(false);
  });

  it("is idempotent — archiving an archived run is not a failure", async () => {
    // A double-click must not read as "no such run", which is what a store
    // counting only CHANGED rows would report.
    const catalog = new PrismaRunCatalog(fakeRuns(rows()), noCosts);
    const at = new Date("2026-01-05T00:00:00.000Z");
    expect(await catalog.setArchived("UGURPAY-1", at)).toBe(true);
    expect(await catalog.setArchived("UGURPAY-1", at)).toBe(true);
  });

  it("touches only the archive column, never the run's own facts", async () => {
    const store = fakeRuns(rows());
    const catalog = new PrismaRunCatalog(store, noCosts);
    const before = (await catalog.list({ ...scope, archived: "all" })).items;

    await catalog.setArchived("UGURPAY-2", new Date("2026-01-05T00:00:00.000Z"));
    const after = (await catalog.list({ ...scope, archived: "all" })).items;

    // Status, step, risk, clocks: a run's history is not edited by tidying the
    // board it appears on.
    for (const [i, row] of after.entries()) {
      const { archivedAt: _ignored, ...rest } = row;
      const { archivedAt: _also, ...wasRest } = before[i] ?? row;
      expect(rest).toEqual(wasRest);
    }
  });

  it("asks the database for the archive clause rather than filtering afterwards", () => {
    // The clause has to reach the WHERE, or paging shortens silently — the
    // same property the project-scope tests above assert, for the same reason.
    expect(archiveWhere("active")).toEqual({ archivedAt: null });
    expect(archiveWhere("archived")).toEqual({ archivedAt: { not: null } });
    // "all" is an ABSENT key, not an enumerated one: no restriction.
    expect(archiveWhere("all")).toEqual({});
  });
});

describe("run catalog: totals and the fan-out family", () => {
  it("sums consumption from the call log", async () => {
    const calls: RunCostDelegate = {
      groupBy: () =>
        Promise.resolve([
          {
            runId: "run-ugurpay-1",
            _sum: { tokensIn: 1200, tokensOut: 300, usd: { toNumber: () => 0.42 } },
          },
        ]),
    };
    const catalog = new PrismaRunCatalog(fakeRuns([run("UGURPAY-1", "2026-01-01T00:00:00.000Z")]), calls);

    const [record] = (await catalog.list({ limit: 5, cursor: null, appId: null, projectKeys: null, archived: "all" }))
      .items;

    expect(record?.costUsd).toBe(0.42);
    expect(record?.tokensIn).toBe(1200);
    expect(record?.tokensOut).toBe(300);
  });

  it("reports zero spend for a subscription run whose usd sums to null", async () => {
    const calls: RunCostDelegate = {
      groupBy: () =>
        Promise.resolve([
          { runId: "run-ugurpay-1", _sum: { tokensIn: 900, tokensOut: 100, usd: null } },
        ]),
    };
    const catalog = new PrismaRunCatalog(fakeRuns([run("UGURPAY-1", "2026-01-01T00:00:00.000Z")]), calls);

    const [record] = (await catalog.list({ limit: 5, cursor: null, appId: null, projectKeys: null, archived: "all" }))
      .items;

    expect(record?.costUsd).toBe(0);
    expect(record?.tokensIn).toBe(900);
  });

  it("reads the parent out of an analysis_fanout match", () => {
    expect(
      parentOf({ via: "analysis_fanout", appId: "ugurpay", parentTicketKey: "UGURPAY-500" }),
    ).toBe("UGURPAY-500");
  });

  it("treats a rule match, a null and a malformed match as having no parent", () => {
    expect(parentOf({ via: "rule", ruleId: "r", appId: "a" })).toBeNull();
    expect(parentOf(null)).toBeNull();
    expect(parentOf("not-json")).toBeNull();
    expect(parentOf({ via: "analysis_fanout", parentTicketKey: 42 })).toBeNull();
  });

  it("links children to their parent within the page", async () => {
    const catalog = new PrismaRunCatalog(
      fakeRuns([
        run("UGURPAY-500", "2026-01-03T00:00:00.000Z"),
        run("UGURPAY-501", "2026-01-02T00:00:00.000Z", {
          matchJson: { via: "analysis_fanout", appId: "ugurweb", parentTicketKey: "UGURPAY-500" },
        }),
      ]),
      noCosts,
    );

    const page = await catalog.list({ limit: 5, cursor: null, appId: null, projectKeys: null, archived: "all" });
    const parent = page.items.find((item) => item.ticketKey === "UGURPAY-500");
    const child = page.items.find((item) => item.ticketKey === "UGURPAY-501");

    expect(parent?.childTicketKeys).toEqual(["UGURPAY-501"]);
    expect(child?.parentTicketKey).toBe("UGURPAY-500");
  });

  /**
   * The status column is the platform's verdict on a run, and the read model is
   * the only way it reaches Studio's list. A store that dropped it would leave
   * the route with nothing but the engine's answer — and a run that died inside
   * an activity answers `running` from the engine forever.
   */
  it("carries the row's own status through rather than dropping it", async () => {
    const catalog = new PrismaRunCatalog(
      fakeRuns([
        run("UGURPAY-1", "2026-01-01T00:00:00.000Z", { status: "fail" }),
        run("UGURPAY-2", "2026-01-02T00:00:00.000Z", { status: "gate" }),
      ]),
      noCosts,
    );

    const page = await catalog.list({ limit: 5, cursor: null, appId: null, projectKeys: null, archived: "all" });

    // Read off the ROW, not defaulted: two rows with different statuses must
    // come back different, which a hardcoded value could not manage.
    expect(page.items.find((item) => item.ticketKey === "UGURPAY-1")?.status).toBe("fail");
    expect(page.items.find((item) => item.ticketKey === "UGURPAY-2")?.status).toBe("gate");
  });

  it("does not claim a run was assessed low risk when it has not been assessed", () => {
    const record = toRunRecord(
      run("UGURPAY-1", "2026-01-01T00:00:00.000Z", { risk: null }),
      undefined,
      undefined,
    );
    expect(record.risk).not.toBe("dusuk");
    expect(record.risk).toBe("orta");
  });
});

describe("run catalog: get", () => {
  it("returns null for a ticket with no run rather than an empty record", async () => {
    const catalog = new PrismaRunCatalog(fakeRuns([]), noCosts);
    expect(await catalog.get("UGURPAY-404")).toBeNull();
  });

  it("returns the newest row for a ticket that was re-run", async () => {
    const rows = [
      { ...run("UGURPAY-9", "2026-01-01T00:00:00.000Z"), id: "run-old" },
      { ...run("UGURPAY-9", "2026-06-01T00:00:00.000Z"), id: "run-new" },
    ];
    const catalog = new PrismaRunCatalog(fakeRuns(rows), noCosts);

    const record = await catalog.get("UGURPAY-9");

    expect(record?.updatedAt).toBe("2026-06-01T00:00:00.000Z");
  });
});

describe("knowledge: an unlabelled corpus is confidential (M18)", () => {
  it("classifies every document gizli, never dahili", () => {
    const doc = toKnowledgeDoc({
      id: "bddk-uyum",
      kind: "policy",
      title: "bddk-uyum.md",
      version: 2,
      contentRef: "knowledge/bddk-uyum.md",
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    // The table has no classification column, and the interface says an index
    // that cannot classify MUST report the strictest class.
    expect(doc.dataClass).toBe("gizli");
  });

  it("does not invent a relevance score", () => {
    const doc = toKnowledgeDoc({
      id: "api-tasarim",
      kind: "standard",
      title: "api-tasarim.md",
      version: 4,
      contentRef: "knowledge/api-tasarim.md",
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    // There is no vector store; a confident-looking 0.93 would be a fiction.
    expect(doc.score).toBe(0);
  });

  it("versions the id so two versions of a document are distinguishable", () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    const base = { id: "analiz-sablonu", kind: "template", title: "t.md", contentRef: "k/t.md", updatedAt: at };
    expect(toKnowledgeDoc({ ...base, version: 2 }).id).not.toBe(
      toKnowledgeDoc({ ...base, version: 3 }).id,
    );
  });
});

describe("sandboxes: audit events fold into workspace state (M60)", () => {
  const box = (
    seq: number,
    action: SandboxAuditRow["action"],
    ticketKey: string,
    runner: string,
    at: string,
    extraMeta: Record<string, unknown> = {},
  ): SandboxAuditRow => ({
    seq: BigInt(seq),
    at: new Date(at),
    action,
    subject: `${ticketKey} · ${runner}`,
    metaJson: { ticketKey, runner, ...extraMeta },
  });

  it("a workspace whose latest event is CREATE is active", () => {
    const records = foldSandboxes([
      box(1, "SANDBOX_CREATE", "UGURPAY-1", "lnx-01", "2026-01-01T00:00:00.000Z"),
    ]);

    expect(records).toHaveLength(1);
    expect(records[0]?.state).toBe("active");
    expect(records[0]?.ticketKey).toBe("UGURPAY-1");
    expect(records[0]?.runnerId).toBe("lnx-01");
    expect(records[0]?.lastAccessAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("a workspace that has since been destroyed is resumable, not gone", () => {
    // Rows arrive newest-first (seq desc), as the store orders them: the DESTROY
    // is seq 2, so it decides the state; the CREATE at seq 1 is folded away.
    const records = foldSandboxes([
      box(2, "SANDBOX_DESTROY", "UGURPAY-1", "lnx-01", "2026-01-02T00:00:00.000Z"),
      box(1, "SANDBOX_CREATE", "UGURPAY-1", "lnx-01", "2026-01-01T00:00:00.000Z"),
    ]);

    expect(records).toHaveLength(1);
    expect(records[0]?.state).toBe("resumable");
    // The most recent event's time, not the create's.
    expect(records[0]?.lastAccessAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("never invents human_held when no meta signals it", () => {
    const records = foldSandboxes([
      box(1, "SANDBOX_CREATE", "UGURPAY-9", "lnx-02", "2026-01-01T00:00:00.000Z"),
    ]);
    expect(records[0]?.state).not.toBe("human_held");
  });

  it("keeps two different workspaces distinct", () => {
    const records = foldSandboxes([
      box(3, "SANDBOX_CREATE", "UGURPAY-2", "lnx-02", "2026-01-03T00:00:00.000Z"),
      box(2, "SANDBOX_DESTROY", "UGURPAY-1", "lnx-01", "2026-01-02T00:00:00.000Z"),
      box(1, "SANDBOX_CREATE", "UGURPAY-1", "lnx-01", "2026-01-01T00:00:00.000Z"),
    ]);

    expect(records.map((r) => `${r.ticketKey}/${r.runnerId}:${r.state}`)).toEqual([
      "UGURPAY-2/lnx-02:active",
      "UGURPAY-1/lnx-01:resumable",
    ]);
  });

  it("reads size from meta when present, else reports 0 rather than a guess", () => {
    const withSize = foldSandboxes([
      box(1, "SANDBOX_CREATE", "UGURPAY-1", "lnx-01", "2026-01-01T00:00:00.000Z", {
        sizeBytes: 4096,
      }),
    ]);
    const withoutSize = foldSandboxes([
      box(1, "SANDBOX_CREATE", "UGURPAY-2", "lnx-02", "2026-01-01T00:00:00.000Z"),
    ]);

    expect(withSize[0]?.sizeBytes).toBe(4096);
    expect(withoutSize[0]?.sizeBytes).toBe(0);
  });

  it("recovers identity from the subject when meta is absent", () => {
    const id = sandboxIdentity({ subject: "UGURPAY-123 · lnx-01", metaJson: null });
    expect(id).toEqual({ ticketKey: "UGURPAY-123", runnerId: "lnx-01" });
  });

  it("skips a row that identifies no workspace at all", () => {
    const records = foldSandboxes([
      {
        seq: 1n,
        at: new Date("2026-01-01T00:00:00.000Z"),
        action: "SANDBOX_CREATE",
        subject: "malformed-subject",
        metaJson: null,
      },
    ]);
    expect(records).toEqual([]);
  });

  it("pages the folded set, respecting limit and continuing by cursor", async () => {
    const rows: SandboxAuditRow[] = [
      box(3, "SANDBOX_CREATE", "UGURPAY-3", "lnx-03", "2026-01-03T00:00:00.000Z"),
      box(2, "SANDBOX_CREATE", "UGURPAY-2", "lnx-02", "2026-01-02T00:00:00.000Z"),
      box(1, "SANDBOX_CREATE", "UGURPAY-1", "lnx-01", "2026-01-01T00:00:00.000Z"),
    ];
    const reader = new PrismaSandboxReader({
      findMany: () => Promise.resolve(rows),
    });

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 5; guard += 1) {
      const page: Awaited<ReturnType<typeof reader.sandboxes>> = await reader.sandboxes({
        limit: 2,
        cursor,
      });
      seen.push(...page.items.map((item) => item.ticketKey));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }

    expect(seen).toEqual(["UGURPAY-3", "UGURPAY-2", "UGURPAY-1"]);
    expect(new Set(seen).size).toBe(3);
  });

  it("only ever asks the audit log for the two sandbox actions", async () => {
    let asked: unknown;
    const reader = new PrismaSandboxReader({
      findMany: (args) => {
        asked = args.where.action.in;
        return Promise.resolve([]);
      },
    });

    await reader.sandboxes({ limit: 10, cursor: null });

    expect(asked).toEqual(["SANDBOX_CREATE", "SANDBOX_DESTROY"]);
  });
});

describe("health: probes report what they established", () => {
  const ok = (service: string): ServiceProbe => ({
    service,
    version: "1.0",
    check: () => Promise.resolve(),
  });
  const broken = (service: string, error: Error): ServiceProbe => ({
    service,
    version: "1.0",
    check: () => Promise.reject(error),
  });

  it("reports a reachable service healthy", async () => {
    const reader = new ProbeHealthReader([ok("postgres")]);
    const [service] = await reader.services();

    expect(service?.state).toBe("healthy");
    expect(service?.note).toBeNull();
  });

  it("reports an unreachable service down instead of omitting it", async () => {
    const reader = new ProbeHealthReader([broken("temporal", new Error("connect ECONNREFUSED"))]);
    const [service] = await reader.services();

    expect(service?.service).toBe("temporal");
    expect(service?.state).toBe("down");
  });

  it("one broken probe does not take down the whole health page", async () => {
    const reader = new ProbeHealthReader([
      ok("postgres"),
      broken("temporal", new Error("nope")),
    ]);

    const services = await reader.services();

    expect(services.map((s) => s.state)).toEqual(["healthy", "down"]);
  });

  it("never lets a connection string reach the note", async () => {
    const leaky = new Error(
      "failed to connect to postgresql://maestro:hunter2@db.internal:5432/maestro",
    );
    const reader = new ProbeHealthReader([broken("postgres", leaky)]);

    const [service] = await reader.services();

    expect(service?.note).not.toContain("hunter2");
    expect(service?.note).not.toContain("postgresql://");
    expect(service?.note).toContain("withheld");
  });

  it("scrubs a non-Error rejection too", () => {
    expect(safeNote("postgresql://user:pw@host/db")).not.toContain("pw@host");
  });

  it("stamps every service with the same checked-at instant", async () => {
    const reader = new ProbeHealthReader([ok("postgres"), ok("temporal")], {
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    });

    const services = await reader.services();

    expect(services.map((s) => s.checkedAt)).toEqual([
      "2026-08-10T12:00:00.000Z",
      "2026-08-10T12:00:00.000Z",
    ]);
  });
});

describe("the wired set: what answers and what refuses", () => {
  const db = {
    workflowRun: fakeRuns([]),
    llmCall: { ...noCosts, findMany: () => Promise.resolve([]), count: () => Promise.resolve(0) },
    journalEntry: { findMany: () => Promise.resolve([]), count: () => Promise.resolve(0) },
    gate: { findMany: () => Promise.resolve([]), count: () => Promise.resolve(0) },
    application: {
      findUnique: () => Promise.resolve(null),
      findMany: () => Promise.resolve([]),
      count: () => Promise.resolve(0),
    },
    repoCard: { findFirst: () => Promise.resolve(null) },
    knowledgeDoc: { findMany: () => Promise.resolve([]), count: () => Promise.resolve(0) },
    subscriptionAccount: { findMany: () => Promise.resolve([]) },
    evidencePackageRow: { findFirst: () => Promise.resolve(null) },
    jiraProjectBinding: {
      findMany: () => Promise.resolve([]),
      findUnique: () => Promise.resolve(null),
    },
    auditLog: { findMany: () => Promise.resolve([]) },
  };
  const build = () =>
    liveReadModels({
      db,
      audit: { head: () => Promise.resolve(null), append: () => Promise.resolve(), read: () => Promise.resolve([]) },
      probes: [],
    });

  it("wires every model the platform has data for", () => {
    const read = build();
    for (const model of ["runs", "journal", "gates", "apps", "knowledge", "quota", "cost", "evidence", "audit", "health"] as const) {
      expect(read[model]).toBeDefined();
    }
  });

  it("refuses the runner fleet list rather than reporting an empty fleet", async () => {
    // An empty page here would render "no runners" — indistinguishable from a
    // fleet that is present and idle.
    await expect(build().runners.list({ limit: 10, cursor: null })).rejects.toThrow(/not wired/);
  });

  it("answers sandboxes from the audit log instead of refusing", async () => {
    // The sibling half of the runners read model is wired: it folds the
    // SANDBOX_* audit events the pilot writes, so it must NOT refuse. An empty
    // audit log yields an empty page here, which is the truth (no workspace has
    // opened), not the "store never filled" lie the fleet list guards against.
    const page = await build().runners.sandboxes({ limit: 10, cursor: null });
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it("refuses scans rather than reporting no findings", async () => {
    await expect(
      build().scans.list({ limit: 10, cursor: null, projectKeys: null }),
    ).rejects.toThrow(/not wired/);
  });

  it("names the two unbacked models for the boot banner", () => {
    expect(UNBACKED_READ_MODELS).toHaveLength(2);
    expect(UNBACKED_READ_MODELS.join(" ")).toContain("runners");
    expect(UNBACKED_READ_MODELS.join(" ")).toContain("scans");
  });

  it("refuses without leaking a connection string", async () => {
    const error = await build()
      .scans.list({ limit: 10, cursor: null, projectKeys: null })
      .catch((caught: unknown) => caught);
    expect(String(error)).not.toMatch(/postgres(ql)?:\/\//);
  });
});
