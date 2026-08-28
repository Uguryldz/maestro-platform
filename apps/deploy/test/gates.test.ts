import { describe, expect, it } from "vitest";
import {
  GateNotFoundError,
  PrismaGateStore,
  type AuditDelegate,
  type AuditRow,
  type GateClaim,
  type GateDelegate,
  type GateRow,
} from "../src/stores/gates.js";

/**
 * The gate store, against a fake that enforces the same primary key the table
 * does — `(runId, step)`. That key IS the idempotency of `open`, so a double
 * that let two rows exist would be testing a different store.
 *
 * `claim` models `INSERT ... ON CONFLICT DO NOTHING`: it inserts when the key
 * is free and does NOTHING — no error, no overwrite — when it is taken. A
 * double that threw on a taken key would make the second `open` look like a
 * failure the real statement does not produce, and one that overwrote would
 * move `openedAt`, the escalation ladder's anchor.
 */
function fakeGates(initial: GateRow[] = []): {
  delegate: GateDelegate;
  claim: GateClaim;
  rows: Map<string, GateRow>;
  inserts: number;
} {
  const rows = new Map<string, GateRow>(initial.map((row) => [`${row.runId}:${row.step}`, row]));
  const state = { inserts: 0 };
  const claim: GateClaim = {
    insertIfAbsent: (runId, step, ownerGroup, openedAt) => {
      const key = `${runId}:${step}`;
      if (rows.has(key)) return Promise.resolve();
      state.inserts += 1;
      rows.set(key, { runId, step, ownerGroup, openedAt, firedStepIds: [], closedAt: null });
      return Promise.resolve();
    },
  };
  const delegate: GateDelegate = {
    findUnique: ({ where }) =>
      Promise.resolve(rows.get(`${where.runId_step.runId}:${where.runId_step.step}`) ?? null),
    update: ({ where, data }) => {
      const key = `${where.runId_step.runId}:${where.runId_step.step}`;
      const existing = rows.get(key);
      if (existing === undefined) throw new Error("no such gate");
      rows.set(key, {
        ...existing,
        ...(data.firedStepIds === undefined
          ? {}
          : { firedStepIds: [...existing.firedStepIds, ...data.firedStepIds.push] }),
        ...(data.closedAt === undefined ? {} : { closedAt: data.closedAt }),
      });
      return Promise.resolve(undefined);
    },
  };
  return {
    delegate,
    claim,
    rows,
    get inserts(): number {
      return state.inserts;
    },
  };
}

function fakeAudit(rows: AuditRow[]): AuditDelegate {
  return {
    findMany: ({ where }) =>
      Promise.resolve(
        rows
          .filter((row) => where.action.in.includes(row.action as never))
          .filter((row) => {
            const meta = row.metaJson as Record<string, unknown>;
            return meta[where.metaJson.path[0] ?? ""] === where.metaJson.equals;
          })
          .sort((a, b) => Number(a.seq - b.seq)),
      ),
  };
}

const OPENED = "2026-08-01T09:00:00.000Z";
const ticketOf = (): Promise<string> => Promise.resolve("PAY-101");

describe("PrismaGateStore.open", () => {
  it("creates a gate and reports it open", async () => {
    const gates = fakeGates();
    const store = new PrismaGateStore(gates.delegate, fakeAudit([]), ticketOf, gates.claim);

    const record = await store.open("run-1", "4", "product-owners", OPENED);
    expect(record).toEqual({
      runId: "run-1",
      step: "4",
      ownerGroup: "product-owners",
      openedAt: OPENED,
      firedStepIds: [],
      closedAt: null,
    });
  });

  /**
   * `openedAt` is the escalation ladder's anchor. Re-opening a gate that has
   * been waiting three days must return the ORIGINAL instant — moving it would
   * silently restart the ladder and the approver would never be escalated.
   */
  it("is idempotent: re-opening returns the existing record and does not move the anchor", async () => {
    const gates = fakeGates();
    const store = new PrismaGateStore(gates.delegate, fakeAudit([]), ticketOf, gates.claim);

    const first = await store.open("run-1", "4", "product-owners", OPENED);
    const second = await store.open("run-1", "4", "product-owners", "2026-08-04T09:00:00.000Z");

    expect(second.openedAt).toBe(first.openedAt);
    expect(gates.rows.size).toBe(1);
  });

  it("keeps the ladder state of a gate that is re-opened", async () => {
    const gates = fakeGates();
    const store = new PrismaGateStore(gates.delegate, fakeAudit([]), ticketOf, gates.claim);

    await store.open("run-1", "4", "product-owners", OPENED);
    await store.markFired("run-1", "4", ["reminder-24h"]);
    const again = await store.open("run-1", "4", "product-owners", OPENED);

    expect(again.firedStepIds).toEqual(["reminder-24h"]);
  });

  it("keeps gates of different steps and different runs apart", async () => {
    const gates = fakeGates();
    const store = new PrismaGateStore(gates.delegate, fakeAudit([]), ticketOf, gates.claim);

    await store.open("run-1", "4", "product-owners", OPENED);
    await store.open("run-1", "5", "tech-leads", OPENED);
    await store.open("run-2", "4", "product-owners", OPENED);

    expect(gates.rows.size).toBe(3);
  });
});

describe("PrismaGateStore.markFired", () => {
  it("appends rather than replacing, so a step is never re-sent", async () => {
    const gates = fakeGates();
    const store = new PrismaGateStore(gates.delegate, fakeAudit([]), ticketOf, gates.claim);

    await store.open("run-1", "4", "product-owners", OPENED);
    await store.markFired("run-1", "4", ["reminder-24h"]);
    await store.markFired("run-1", "4", ["escalation-72h"]);

    const record = await store.get("run-1", "4");
    expect(record?.firedStepIds).toEqual(["reminder-24h", "escalation-72h"]);
  });

  it("writes nothing when there is nothing to record", async () => {
    const gates = fakeGates();
    const store = new PrismaGateStore(gates.delegate, fakeAudit([]), ticketOf, gates.claim);
    await store.open("run-1", "4", "product-owners", OPENED);
    await store.markFired("run-1", "4", []);
    expect((await store.get("run-1", "4"))?.firedStepIds).toEqual([]);
  });

  /**
   * The in-memory reference double returns silently here. Escalating a gate
   * nobody is waiting on is worth a page, not a shrug.
   */
  it("refuses to mark a step fired on a gate that does not exist", async () => {
    const gates = fakeGates();
    const store = new PrismaGateStore(gates.delegate, fakeAudit([]), ticketOf, gates.claim);
    await expect(store.markFired("run-1", "4", ["reminder-24h"])).rejects.toBeInstanceOf(
      GateNotFoundError,
    );
  });
});

describe("PrismaGateStore.close", () => {
  it("records the closing instant", async () => {
    const gates = fakeGates();
    const store = new PrismaGateStore(gates.delegate, fakeAudit([]), ticketOf, gates.claim);

    await store.open("run-1", "4", "product-owners", OPENED);
    await store.close("run-1", "4", "2026-08-02T10:00:00.000Z");

    expect((await store.get("run-1", "4"))?.closedAt).toBe("2026-08-02T10:00:00.000Z");
  });

  /**
   * Found live on OPS-36. The Jira poller re-reads a comment thread from the
   * start after a restart, so an `/approve` written BEFORE this gate opened
   * arrives carrying its original timestamp. The column's
   * `closedAt >= openedAt` check then fired, and a check-constraint violation
   * is not retryable — `recordGateDecision` burned its three attempts and the
   * whole workflow failed, with a valid approval on the table.
   */
  it("never writes a close that predates the open, and does not fail over one", async () => {
    const gates = fakeGates();
    const store = new PrismaGateStore(gates.delegate, fakeAudit([]), ticketOf, gates.claim);

    await store.open("run-1", "4", "product-owners", OPENED);
    await store.close("run-1", "4", "2026-08-01T00:00:00.000Z");

    // Clamped to the open, not refused: the decision is real, and the audit
    // trail already holds its true time, signed and chained.
    expect((await store.get("run-1", "4"))?.closedAt).toBe(OPENED);
  });

  it("refuses to close a gate that was never opened", async () => {
    const gates = fakeGates();
    const store = new PrismaGateStore(gates.delegate, fakeAudit([]), ticketOf, gates.claim);
    await expect(store.close("run-1", "4", OPENED)).rejects.toBeInstanceOf(GateNotFoundError);
  });

  it("returns null for a gate that does not exist rather than inventing one", async () => {
    const gates = fakeGates();
    const store = new PrismaGateStore(gates.delegate, fakeAudit([]), ticketOf, gates.claim);
    expect(await store.get("run-1", "4")).toBeNull();
  });
});

/**
 * The decisions come from the audit chain, never from a second table: a
 * decision's `signatureSeq` IS the seq of the audit record it produced, so the
 * chain is the only place a signed approval can honestly come from.
 */
describe("PrismaGateStore.decisions", () => {
  const approval: AuditRow = {
    seq: 81390n,
    at: new Date("2026-08-02T10:00:00.000Z"),
    actor: "ayse.kaya@ugurbank.local",
    action: "GATE_APPROVE",
    metaJson: {
      ticketKey: "PAY-101",
      step: "4",
      actorGroup: "product-owners",
      source: "jira",
      sodVerified: true,
    },
  };

  it("rebuilds a decision, taking the signature from the record's own seq", async () => {
    const gates = fakeGates();
    const store = new PrismaGateStore(gates.delegate, fakeAudit([approval]), ticketOf, gates.claim);

    const [decision] = await store.decisions("run-1");
    expect(decision).toEqual({
      step: "4",
      decision: "approve",
      actorUserId: "ayse.kaya@ugurbank.local",
      actorGroup: "product-owners",
      sodVerified: true,
      signatureSeq: 81390,
      source: "jira",
      at: "2026-08-02T10:00:00.000Z",
    });
  });

  it("carries a rejection's reason", async () => {
    const rejection: AuditRow = {
      ...approval,
      seq: 81391n,
      action: "GATE_REJECT",
      metaJson: { ...(approval.metaJson as object), reason: "kapsam eksik" },
    };
    const gates = fakeGates();
    const store = new PrismaGateStore(gates.delegate, fakeAudit([rejection]), ticketOf, gates.claim);

    const [decision] = await store.decisions("run-1");
    expect(decision?.decision).toBe("reject");
    expect(decision?.reason).toBe("kapsam eksik");
  });

  /**
   * A half-built decision must never reach an evidence package: an approval
   * with no group is one an auditor cannot attribute, and a rejection with no
   * reason is one the contract itself refuses.
   */
  it("refuses a record whose meta cannot make a complete decision", async () => {
    const incomplete: AuditRow = {
      ...approval,
      metaJson: { ticketKey: "PAY-101", step: "4", source: "jira" },
    };
    const gates = fakeGates();
    const store = new PrismaGateStore(gates.delegate, fakeAudit([incomplete]), ticketOf, gates.claim);
    await expect(store.decisions("run-1")).rejects.toThrow();
  });

  it("refuses a rejection recorded without a reason", async () => {
    const bad: AuditRow = {
      ...approval,
      action: "GATE_REJECT",
      metaJson: { ...(approval.metaJson as object) },
    };
    const gates = fakeGates();
    const store = new PrismaGateStore(gates.delegate, fakeAudit([bad]), ticketOf, gates.claim);
    await expect(store.decisions("run-1")).rejects.toThrow();
  });

  it("treats a missing sodVerified as not verified", async () => {
    const unverified: AuditRow = {
      ...approval,
      metaJson: {
        ticketKey: "PAY-101",
        step: "4",
        actorGroup: "product-owners",
        source: "jira",
      },
    };
    const gates = fakeGates();
    const store = new PrismaGateStore(gates.delegate, fakeAudit([unverified]), ticketOf, gates.claim);
    const [decision] = await store.decisions("run-1");
    expect(decision?.sodVerified).toBe(false);
  });

  it("ignores audit records that are not gate decisions", async () => {
    const noise: AuditRow = {
      seq: 5n,
      at: new Date("2026-08-01T09:00:00.000Z"),
      actor: "maestro-worker",
      action: "RUN_STARTED",
      metaJson: { ticketKey: "PAY-101" },
    };
    const gates = fakeGates();
    const store = new PrismaGateStore(gates.delegate, fakeAudit([noise, approval]), ticketOf, gates.claim);
    expect(await store.decisions("run-1")).toHaveLength(1);
  });
});
