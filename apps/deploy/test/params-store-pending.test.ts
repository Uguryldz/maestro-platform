import type { PendingParamChange } from "@maestro/bff";
import { describe, expect, it } from "vitest";
import {
  PrismaParamStore,
  type PendingDelegate,
  type PendingRow,
} from "../src/stores/params-store.js";

/**
 * The durable open-proposal queue (migration 0013).
 *
 * The delegate is a Map keyed by `${key} ${scopeRef}` — the `PendingParamChange`
 * table with its `(key, scopeRef)` primary key. The properties under test:
 * put→pending round-trips every field, the global scope ("" ↔ null) survives the
 * trip, upsert replaces rather than duplicates one slot, and clearPending removes
 * exactly one slot. The definition/version delegates are unused here, so they are
 * trivial stubs — this file exercises only the pending path.
 */

function fakePending(): { delegate: PendingDelegate; rows: Map<string, PendingRow> } {
  const rows = new Map<string, PendingRow>();
  const keyOf = (key: string, scopeRef: string): string => `${key} ${scopeRef}`;
  const delegate: PendingDelegate = {
    findMany: () =>
      Promise.resolve([...rows.values()].sort((a, b) => a.key.localeCompare(b.key))),
    upsert: (args) => {
      const { key, scopeRef } = args.where.key_scopeRef;
      const existing = rows.get(keyOf(key, scopeRef));
      rows.set(
        keyOf(key, scopeRef),
        existing === undefined ? { ...args.create } : { ...existing, ...args.update },
      );
      return Promise.resolve(rows.get(keyOf(key, scopeRef)));
    },
    deleteMany: (args) => {
      rows.delete(keyOf(args.where.key, args.where.scopeRef));
      return Promise.resolve({ count: 1 });
    },
  };
  return { delegate, rows };
}

function store(pending: PendingDelegate): PrismaParamStore {
  // Definition/version delegates are never touched by the pending methods.
  const noDefs = { findMany: () => Promise.resolve([]) };
  const noVersions = {
    findMany: () => Promise.resolve([]),
    create: () => Promise.resolve({}),
  };
  return new PrismaParamStore(noDefs, noVersions, pending);
}

const change = (over: Partial<PendingParamChange> = {}): PendingParamChange => ({
  key: "notify.teams.webhook",
  scopeRef: null,
  value: { url: "https://example/hook" },
  proposedBy: "ayse@corp",
  at: "2026-08-13T10:00:00.000Z",
  ...over,
});

describe("PrismaParamStore pending queue (durable, 0013)", () => {
  it("round-trips a global-scope proposal through the table", async () => {
    const { delegate } = fakePending();
    const s = store(delegate);

    await s.putPending(change());
    const open = await s.pending();

    expect(open).toEqual([
      {
        key: "notify.teams.webhook",
        scopeRef: null, // stored as "", read back as null
        value: { url: "https://example/hook" },
        proposedBy: "ayse@corp",
        at: "2026-08-13T10:00:00.000Z",
      },
    ]);
  });

  it("keeps a project-scoped onboarding proposal distinct from a global one", async () => {
    const { delegate } = fakePending();
    const s = store(delegate);

    await s.putPending(change());
    await s.putPending(
      change({ key: "onboarding.binding", scopeRef: "OPS", value: { adoRepo: "o/r" } }),
    );

    const open = await s.pending();
    expect(open).toHaveLength(2);
    const ops = open.find((p) => p.key === "onboarding.binding");
    expect(ops?.scopeRef).toBe("OPS");
    expect(ops?.value).toEqual({ adoRepo: "o/r" });
  });

  it("upserts one slot: re-proposing the same key+scope replaces, not duplicates", async () => {
    const { delegate } = fakePending();
    const s = store(delegate);

    await s.putPending(change({ proposedBy: "ayse@corp" }));
    await s.putPending(change({ proposedBy: "mert@corp", value: { url: "https://new/hook" } }));

    const open = await s.pending();
    expect(open).toHaveLength(1);
    expect(open[0]?.proposedBy).toBe("mert@corp");
    expect(open[0]?.value).toEqual({ url: "https://new/hook" });
  });

  it("clearPending removes exactly the named slot", async () => {
    const { delegate } = fakePending();
    const s = store(delegate);

    await s.putPending(change());
    await s.putPending(change({ key: "onboarding.binding", scopeRef: "OPS" }));
    await s.clearPending("onboarding.binding", "OPS");

    const open = await s.pending();
    expect(open.map((p) => p.key)).toEqual(["notify.teams.webhook"]);
  });
});
