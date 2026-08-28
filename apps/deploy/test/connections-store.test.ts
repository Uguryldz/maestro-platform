import type { ConnectionRecord } from "@maestro/bff";
import { describe, expect, it } from "vitest";
import {
  PrismaConnectionStore,
  type ConnectionDelegate,
  type ConnectionRow,
} from "../src/stores/connections.js";

/**
 * The Postgres-backed connection store, offline.
 *
 * The delegate is a Map keyed by id — the `Connection` table with its `id`
 * primary key. The properties under test: a put/get round-trips every field, a
 * restart (a new store over the same rows) still reads them, `recordTest` writes
 * only the test pair, `remove` returns the `secretRef` so the caller can drop the
 * secret, and the stored ROW never holds a token.
 */

function fakeDelegate(): { delegate: ConnectionDelegate; rows: Map<string, ConnectionRow> } {
  const rows = new Map<string, ConnectionRow>();
  const delegate: ConnectionDelegate = {
    findMany: () =>
      Promise.resolve(
        [...rows.values()].sort((a, b) => a.id.localeCompare(b.id)),
      ),
    findUnique: (args) => Promise.resolve(rows.get(args.where.id) ?? null),
    upsert: (args) => {
      const existing = rows.get(args.where.id);
      rows.set(args.where.id, existing === undefined
        ? args.create
        : { ...existing, ...args.update });
      return Promise.resolve(rows.get(args.where.id));
    },
    update: (args) => {
      const existing = rows.get(args.where.id);
      if (existing === undefined) return Promise.reject(new Error("not found"));
      rows.set(args.where.id, { ...existing, ...args.data });
      return Promise.resolve(rows.get(args.where.id));
    },
    delete: (args) => {
      const existing = rows.get(args.where.id);
      if (existing === undefined) return Promise.reject(new Error("not found"));
      rows.delete(args.where.id);
      return Promise.resolve(existing);
    },
  };
  return { delegate, rows };
}

function record(over: Partial<ConnectionRecord> = {}): ConnectionRecord {
  return {
    id: "jira",
    kind: "jira_cloud",
    displayName: "Jira Cloud",
    baseUrl: "https://ugurbank.atlassian.net",
    authKind: "basic",
    config: { email: "bot@ugurbank.local" },
    secretRef: "connector:jira:abc",
    secretMask: "1234",
    enabled: true,
    createdAt: "2026-08-10T09:00:00.000Z",
    updatedAt: "2026-08-10T09:00:00.000Z",
    lastTestedAt: null,
    lastTestOk: null,
    lastTestNote: null,
    onPrem: false,
    isDefault: false,
    ...over,
  };
}

describe("PrismaConnectionStore", () => {
  it("round-trips every field through put/get", async () => {
    const { delegate } = fakeDelegate();
    const store = new PrismaConnectionStore(delegate);
    const input = record();
    await store.put(input);
    expect(await store.get("jira")).toEqual(input);
  });

  it("survives a restart — a new store over the same rows reads them", async () => {
    const { delegate } = fakeDelegate();
    await new PrismaConnectionStore(delegate).put(record());
    const afterRestart = new PrismaConnectionStore(delegate);
    expect((await afterRestart.get("jira"))?.displayName).toBe("Jira Cloud");
  });

  it("stores only a secret REFERENCE and mask on the row — never a token", async () => {
    const { delegate, rows } = fakeDelegate();
    const store = new PrismaConnectionStore(delegate);
    await store.put(record());
    const row = rows.get("jira")!;
    // The row shape has a secretRef/secretMask and no field that could hold a token.
    expect(row.secretRef).toBe("connector:jira:abc");
    expect(row.secretMask).toBe("1234");
    expect(JSON.stringify(row)).not.toMatch(/token/i);
  });

  it("recordTest writes the test pair and keeps the rest", async () => {
    const { delegate } = fakeDelegate();
    const store = new PrismaConnectionStore(delegate);
    await store.put(record());
    await store.recordTest("jira", { at: "2026-08-10T10:00:00.000Z", ok: true });
    const after = await store.get("jira");
    expect(after?.lastTestOk).toBe(true);
    expect(after?.lastTestedAt).toBe("2026-08-10T10:00:00.000Z");
    expect(after?.displayName).toBe("Jira Cloud");
  });

  it("lists connections ordered by id", async () => {
    const { delegate } = fakeDelegate();
    const store = new PrismaConnectionStore(delegate);
    await store.put(record({ id: "vault", secretRef: null, secretMask: null }));
    await store.put(record({ id: "github" }));
    expect((await store.list()).map((c) => c.id)).toEqual(["github", "vault"]);
  });

  it("remove returns the secretRef so the caller can drop the secret too", async () => {
    const { delegate } = fakeDelegate();
    const store = new PrismaConnectionStore(delegate);
    await store.put(record());
    expect(await store.remove("jira")).toEqual({ secretRef: "connector:jira:abc" });
    expect(await store.get("jira")).toBeNull();
  });

  it("remove returns null for a connection that does not exist", async () => {
    const { delegate } = fakeDelegate();
    const store = new PrismaConnectionStore(delegate);
    expect(await store.remove("nope")).toBeNull();
  });

  it("keeps a null secretRef as null (a config-only connection with no token)", async () => {
    const { delegate } = fakeDelegate();
    const store = new PrismaConnectionStore(delegate);
    await store.put(record({ secretRef: null, secretMask: null }));
    const stored = await store.get("jira");
    expect(stored?.secretRef).toBeNull();
    expect(stored?.secretMask).toBeNull();
  });
});
