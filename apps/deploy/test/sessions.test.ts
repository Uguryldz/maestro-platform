import { describe, expect, it } from "vitest";
import type { SessionRecord } from "@maestro/bff";
import {
  PrismaSessionStore,
  type SessionDelegate,
  type SessionRow,
  type SessionWriteRow,
} from "../src/stores/sessions.js";

/**
 * The Postgres-backed session store, offline.
 *
 * The delegate is a plain in-memory fake — the store takes the five
 * `PrismaClient.session` methods by SHAPE, which is what lets these tests run
 * without a database and without `prisma generate`. The fake enforces the same
 * primary-key and filter behaviour Postgres would, so a logic bug shows up here.
 */

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    token: "tok-abc",
    userId: "ugur@corp",
    username: "ugur",
    roles: ["viewer", "admin"],
    groups: ["maestro-admins"],
    delegated: false,
    issuedAt: "2026-08-10T09:00:00.000Z",
    expiresAt: "2026-08-10T17:00:00.000Z",
    ...overrides,
  };
}

/** A fake `session` delegate backed by a Map keyed on the token (the PK). */
function fakeDelegate(seed: SessionRow[] = []): { delegate: SessionDelegate; rows: Map<string, SessionRow> } {
  const rows = new Map<string, SessionRow>();
  for (const row of seed) rows.set(row.token, row);

  const delegate: SessionDelegate = {
    create: (args: { data: SessionWriteRow }) => {
      const { data } = args;
      if (rows.has(data.token)) {
        // The primary key: a duplicate token is a hard failure, like Postgres.
        return Promise.reject(Object.assign(new Error("unique"), { code: "P2002" }));
      }
      rows.set(data.token, { ...data });
      return Promise.resolve(data);
    },
    findUnique: (args) => Promise.resolve(rows.get(args.where.token) ?? null),
    delete: (args) => {
      if (!rows.has(args.where.token)) {
        return Promise.reject(Object.assign(new Error("not found"), { code: "P2025" }));
      }
      rows.delete(args.where.token);
      return Promise.resolve({});
    },
    findMany: (args) => {
      const owned = [...rows.values()]
        .filter((row) => row.userId === args.where.userId)
        .sort((a, b) => a.issuedAt.getTime() - b.issuedAt.getTime());
      return Promise.resolve(owned);
    },
    deleteMany: (args) => {
      let count = 0;
      for (const [token, row] of rows) {
        if (row.userId === args.where.userId) {
          rows.delete(token);
          count += 1;
        }
      }
      return Promise.resolve({ count });
    },
  };
  return { delegate, rows };
}

describe("PrismaSessionStore.create + get", () => {
  it("round-trips a session through the delegate", async () => {
    const { delegate } = fakeDelegate();
    const store = new PrismaSessionStore(delegate);
    await store.create(record());

    const got = await store.get("tok-abc");
    expect(got).toEqual(record());
  });

  it("writes roles and groups as string arrays, and reads them back", async () => {
    const { delegate, rows } = fakeDelegate();
    const store = new PrismaSessionStore(delegate);
    await store.create(record({ roles: ["qa"], groups: ["developers", "qa"] }));

    // Stored as arrays (the write shape), not the readonly contract arrays.
    expect(rows.get("tok-abc")?.rolesJson).toEqual(["qa"]);
    expect(rows.get("tok-abc")?.groupsJson).toEqual(["developers", "qa"]);
  });

  it("carries the delegated flag so a restart cannot re-open a human-only channel (M101)", async () => {
    const { delegate } = fakeDelegate();
    const store = new PrismaSessionStore(delegate);
    await store.create(record({ token: "tok-ai", delegated: true }));
    expect((await store.get("tok-ai"))?.delegated).toBe(true);
  });

  it("returns null for an unknown token", async () => {
    const { delegate } = fakeDelegate();
    const store = new PrismaSessionStore(delegate);
    expect(await store.get("nope")).toBeNull();
  });

  it("treats a malformed roles/groups column as empty, never a bogus grant", async () => {
    const { delegate } = fakeDelegate([
      {
        token: "tok-bad",
        userId: "x@corp",
        username: "x",
        rolesJson: "admin", // not an array — must not become a role
        groupsJson: [1, "developers", null], // mixed — only the string survives
        delegated: false,
        issuedAt: new Date("2026-08-10T09:00:00.000Z"),
        expiresAt: new Date("2026-08-10T17:00:00.000Z"),
      },
    ]);
    const store = new PrismaSessionStore(delegate);
    const got = await store.get("tok-bad");
    expect(got?.roles).toEqual([]);
    expect(got?.groups).toEqual(["developers"]);
  });
});

describe("PrismaSessionStore.delete", () => {
  it("removes a session", async () => {
    const { delegate } = fakeDelegate();
    const store = new PrismaSessionStore(delegate);
    await store.create(record());
    await store.delete("tok-abc");
    expect(await store.get("tok-abc")).toBeNull();
  });

  it("is a no-op when the token is already gone (a raced logout must not 500)", async () => {
    const { delegate } = fakeDelegate();
    const store = new PrismaSessionStore(delegate);
    await expect(store.delete("never-existed")).resolves.toBeUndefined();
  });
});

describe("PrismaSessionStore.listByUser", () => {
  it("returns a user's sessions oldest-first, so the eviction cap drops the oldest", async () => {
    const { delegate } = fakeDelegate();
    const store = new PrismaSessionStore(delegate);
    await store.create(record({ token: "t-new", issuedAt: "2026-08-10T12:00:00.000Z" }));
    await store.create(record({ token: "t-old", issuedAt: "2026-08-10T08:00:00.000Z" }));

    const list = await store.listByUser("ugur@corp");
    expect(list.map((s) => s.token)).toEqual(["t-old", "t-new"]);
  });

  it("scopes to the requested user only", async () => {
    const { delegate } = fakeDelegate();
    const store = new PrismaSessionStore(delegate);
    await store.create(record({ token: "t1", userId: "a@corp" }));
    await store.create(record({ token: "t2", userId: "b@corp" }));
    const list = await store.listByUser("a@corp");
    expect(list.map((s) => s.token)).toEqual(["t1"]);
  });
});

describe("PrismaSessionStore.deleteByUser", () => {
  it("drops every session an account holds and reports the count (M8/M32)", async () => {
    const { delegate } = fakeDelegate();
    const store = new PrismaSessionStore(delegate);
    await store.create(record({ token: "t1", userId: "a@corp" }));
    await store.create(record({ token: "t2", userId: "a@corp" }));
    await store.create(record({ token: "t3", userId: "b@corp" }));

    expect(await store.deleteByUser("a@corp")).toBe(2);
    expect(await store.get("t1")).toBeNull();
    expect(await store.get("t2")).toBeNull();
    expect(await store.get("t3")).not.toBeNull();
  });
});
