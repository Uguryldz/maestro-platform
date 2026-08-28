import type { ListeningRuleRecord } from "@maestro/bff";
import { DB_NULL } from "@maestro/db";
import { describe, expect, it } from "vitest";
import {
  PrismaListeningStore,
  type ListeningDelegate,
  type ListeningRuleRow,
} from "../src/stores/listening.js";

/**
 * The Postgres-backed listening-rule store, offline.
 *
 * The delegate is a Map keyed by `ruleId` — the `ListeningRule` table with its
 * primary key. Properties under test: a put/get round-trips every field, list is
 * ordered by (projectKey, priority), a restart (a new store over the same rows)
 * still reads them, and remove reports whether a row existed.
 *
 * The Jira status map (migration 0018) gets its own block, because it is the one
 * column that can be WRONG rather than merely absent — free-shaped jsonb — and
 * the property that matters is that a wrong one degrades instead of throwing.
 */

/**
 * What Postgres does with Prisma's `DbNull`, done here too.
 *
 * The store cannot send a bare `null` on a Json column — Prisma refuses it as
 * ambiguous — so it sends the `DbNull` sentinel, and the real driver turns that
 * into SQL NULL before the row is ever stored. A fake that skipped the
 * translation would hold a value no database can hold, and every assertion
 * below would be written against a shape production never sees.
 */
function storedShape(row: ListeningRuleRow): ListeningRuleRow {
  return row.statusMapJson === DB_NULL ? { ...row, statusMapJson: null } : row;
}

function fakeDelegate(): { delegate: ListeningDelegate; rows: Map<string, ListeningRuleRow> } {
  const rows = new Map<string, ListeningRuleRow>();
  const delegate: ListeningDelegate = {
    findMany: () =>
      Promise.resolve(
        [...rows.values()].sort(
          (a, b) => a.projectKey.localeCompare(b.projectKey) || a.priority - b.priority,
        ),
      ),
    findUnique: (args) => Promise.resolve(rows.get(args.where.ruleId) ?? null),
    upsert: (args) => {
      const existing = rows.get(args.where.ruleId);
      rows.set(
        args.where.ruleId,
        storedShape(
          existing === undefined
            ? (args.create as ListeningRuleRow)
            : ({ ...existing, ...args.update } as ListeningRuleRow),
        ),
      );
      return Promise.resolve(rows.get(args.where.ruleId));
    },
    delete: (args) => {
      const existing = rows.get(args.where.ruleId);
      if (existing === undefined) return Promise.reject(new Error("not found"));
      rows.delete(args.where.ruleId);
      return Promise.resolve(existing);
    },
  };
  return { delegate, rows };
}

function record(over: Partial<ListeningRuleRecord> = {}): ListeningRuleRecord {
  return {
    ruleId: "lr_1",
    projectKey: "OPS",
    assigneeAccountId: "712020:bot",
    matchKind: "issuetype",
    matchValue: "Hata",
    flowType: "duzeltme",
    priority: 100,
    enabled: true,
    // Faz 3 agent mapping — null is the stored form of "default agent".
    analystVariantId: null,
    engineerVariantId: null,
    // No Jira status map — comment-only mode, the pre-0018 behaviour.
    statusMap: null,
    ...over,
  };
}

/**
 * A raw row, for the tests that must plant something in the "database" that the
 * platform's own write path would never produce (a corrupt status map). Kept
 * local rather than exported from the store: production code has no business
 * building a row that skips validation.
 */
function toRow(from: ListeningRuleRecord): ListeningRuleRow {
  return {
    ruleId: from.ruleId,
    projectKey: from.projectKey,
    assigneeAccountId: from.assigneeAccountId,
    matchKind: from.matchKind,
    matchValue: from.matchValue,
    flowType: from.flowType,
    priority: from.priority,
    enabled: from.enabled,
    analystVariantId: from.analystVariantId ?? null,
    engineerVariantId: from.engineerVariantId ?? null,
    statusMapJson: null,
  };
}

describe("PrismaListeningStore", () => {
  it("round-trips every field through put/get", async () => {
    const { delegate } = fakeDelegate();
    const store = new PrismaListeningStore(delegate);
    await store.put(record());
    expect(await store.get("lr_1")).toEqual(record());
  });

  it("survives a restart — a new store over the same rows reads them", async () => {
    const { delegate, rows } = fakeDelegate();
    await new PrismaListeningStore(delegate).put(record());
    const restarted = new PrismaListeningStore({
      ...delegate,
      findMany: () => Promise.resolve([...rows.values()]),
    });
    expect(await restarted.get("lr_1")).toEqual(record());
  });

  it("round-trips the Faz 3 agent-variant mapping (akış→ajan)", async () => {
    const { delegate } = fakeDelegate();
    const store = new PrismaListeningStore(delegate);
    await store.put(
      record({ analystVariantId: "mobil-analist", engineerVariantId: "mobil-muhendis" }),
    );
    const read = await store.get("lr_1");
    expect(read?.analystVariantId).toBe("mobil-analist");
    expect(read?.engineerVariantId).toBe("mobil-muhendis");
  });

  it("an ABSENT variant field is stored as NULL (default agent), not dropped", async () => {
    const { delegate, rows } = fakeDelegate();
    const store = new PrismaListeningStore(delegate);
    // A record written before the mapping existed carries no variant fields at
    // all — the column write must normalise that to NULL, never undefined.
    const { analystVariantId: _a, engineerVariantId: _e, ...legacy } = record();
    await store.put(legacy as ListeningRuleRecord);
    expect(rows.get("lr_1")?.analystVariantId).toBeNull();
    expect(rows.get("lr_1")?.engineerVariantId).toBeNull();
    expect((await store.get("lr_1"))?.analystVariantId).toBeNull();
  });

  it("lists ordered by (projectKey, priority)", async () => {
    const { delegate } = fakeDelegate();
    const store = new PrismaListeningStore(delegate);
    await store.put(record({ ruleId: "b", projectKey: "OPS", priority: 200 }));
    await store.put(record({ ruleId: "a", projectKey: "OPS", priority: 50 }));
    await store.put(record({ ruleId: "c", projectKey: "APP", priority: 10 }));
    const list = await store.list();
    expect(list.map((r) => r.ruleId)).toEqual(["c", "a", "b"]);
  });

  it("round-trips a FULL Jira status map (transition mode)", async () => {
    const { delegate, rows } = fakeDelegate();
    const store = new PrismaListeningStore(delegate);
    // The four statuses the user's real OPS project actually has.
    const statusMap = {
      onStart: "Devam Ediyor",
      onNeedInfo: "Yapılacaklar",
      onReview: "İNCELEMEDE",
      onRejected: "Devam Ediyor",
      onDone: "Tamam",
      reassignOnNeedInfo: true,
    };
    await store.put(record({ statusMap }));
    // It reaches the COLUMN as a document, not a string — a stringified map
    // would read back as a parse failure and silently degrade to null.
    expect(rows.get("lr_1")?.statusMapJson).toEqual(statusMap);
    expect((await store.get("lr_1"))?.statusMap).toEqual(statusMap);
  });

  it("a PARTIAL map keeps exactly the points the operator mapped", async () => {
    const { delegate } = fakeDelegate();
    const store = new PrismaListeningStore(delegate);
    // An operator who only cares that finished work lands in 'Tamam'. Every
    // other point stays unmapped, which the driver reads as "do not move it".
    await store.put(record({ statusMap: { onDone: "Tamam" } }));
    expect((await store.get("lr_1"))?.statusMap).toEqual({ onDone: "Tamam" });
  });

  it("no map stays NULL — comment-only mode survives a round trip", async () => {
    const { delegate, rows } = fakeDelegate();
    const store = new PrismaListeningStore(delegate);
    await store.put(record({ statusMap: null }));
    expect(rows.get("lr_1")?.statusMapJson).toBeNull();
    expect((await store.get("lr_1"))?.statusMap).toBeNull();
  });

  it("an ABSENT map field is stored as NULL, exactly like a pre-0018 row", async () => {
    const { delegate, rows } = fakeDelegate();
    const store = new PrismaListeningStore(delegate);
    const { statusMap: _s, ...legacy } = record();
    await store.put(legacy as ListeningRuleRecord);
    expect(rows.get("lr_1")?.statusMapJson).toBeNull();
    expect((await store.get("lr_1"))?.statusMap).toBeNull();
  });

  it("an EMPTY map normalises to NULL — one representation of 'moves nothing'", async () => {
    const { delegate, rows } = fakeDelegate();
    const store = new PrismaListeningStore(delegate);
    await store.put(record({ statusMap: {} }));
    expect(rows.get("lr_1")?.statusMapJson).toBeNull();
    expect((await store.get("lr_1"))?.statusMap).toBeNull();
  });

  it("a MALFORMED map in the column degrades to comment-only and never throws", async () => {
    // The blast radius is the point: a row someone hand-edited in psql, or one
    // written by a future version, must not take the rule list down — and with
    // it discovery for every project. Three shapes the column can really hold.
    for (const bad of [
      { onDone: 42 }, // wrong value type
      { onDoneX: "Tamam" }, // misspelt key — .strict() rejects it
      "Tamam", // not an object at all
    ]) {
      const { delegate, rows } = fakeDelegate();
      const warnings: string[] = [];
      const store = new PrismaListeningStore(delegate, (m) => warnings.push(m));
      // Bypass `put` deliberately: the corruption arrives in the DATABASE, not
      // through the platform's own validated write path.
      rows.set("lr_1", { ...toRow(record()), statusMapJson: bad });

      const read = await store.get("lr_1");
      expect(read?.statusMap).toBeNull();
      // The rest of the rule is intact — one bad field costs the map, not the rule.
      expect(read?.flowType).toBe("duzeltme");
      expect(read?.matchValue).toBe("Hata");
      // And the degradation is REPORTED, not silent: an operator whose board
      // stopped moving needs the reason to exist somewhere.
      expect(warnings.join(" ")).toContain("lr_1");
    }
  });

  it("list() survives a malformed map among healthy rows", async () => {
    const { delegate, rows } = fakeDelegate();
    const store = new PrismaListeningStore(delegate, () => {});
    rows.set("lr_bad", {
      ...toRow(record({ ruleId: "lr_bad", matchValue: "Bozuk" })),
      statusMapJson: { onStart: ["nope"] },
    });
    rows.set("lr_ok", {
      ...toRow(record({ ruleId: "lr_ok", matchValue: "Sağlam" })),
      statusMapJson: { onDone: "Tamam" },
    });

    const list = await store.list();
    expect(list).toHaveLength(2);
    expect(list.find((r) => r.ruleId === "lr_bad")?.statusMap).toBeNull();
    expect(list.find((r) => r.ruleId === "lr_ok")?.statusMap).toEqual({ onDone: "Tamam" });
  });

  it("remove reports whether the row existed", async () => {
    const { delegate } = fakeDelegate();
    const store = new PrismaListeningStore(delegate);
    await store.put(record());
    expect(await store.remove("lr_1")).toBe(true);
    expect(await store.remove("lr_1")).toBe(false);
    expect(await store.get("lr_1")).toBeNull();
  });
});
