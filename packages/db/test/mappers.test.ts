import { describe, expect, it } from "vitest";
import { AuditEvent, LlmCallLog, ParamChange, WorkflowRunState } from "@maestro/contracts";
import {
  APPEND_ONLY_METHODS,
  appendOnly,
  bigIntToNumber,
  BigIntRangeError,
  decimalToNumber,
  InvalidRuleProjectKeyError,
  isOrgWideRule,
  ORG_WIDE_PROJECT_KEY,
  toAuditEvent,
  toColumnProjectKey,
  toContractProjectKey,
  toJournalEntry,
  toLlmCallLog,
  toParamChange,
  toWorkflowRunState,
} from "../src/index.js";

describe("BigInt and Decimal conversion (the documented crossing point)", () => {
  it("converts a BigInt column to a contract number", () => {
    expect(bigIntToNumber("AuditLog.seq", 81_422n)).toBe(81_422);
  });

  it("refuses a BigInt that would lose precision instead of rounding it", () => {
    const tooBig = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
    expect(() => bigIntToNumber("AuditLog.seq", tooBig)).toThrow(BigIntRangeError);
  });

  it("converts Decimal money to a number and keeps null null (M55)", () => {
    expect(decimalToNumber({ toNumber: () => 0.42 })).toBe(0.42);
    expect(decimalToNumber(null)).toBeNull();
  });
});

describe("row -> contract mappers", () => {
  const at = new Date("2026-08-08T11:20:00.000Z");

  it("maps an AuditLog row into a contract AuditEvent", () => {
    const event = toAuditEvent({
      seq: 7n,
      at,
      actor: "maestro-worker",
      action: "RUN_STARTED",
      subject: "UGURPAY-123",
      prevHash: "genesis",
      hash: "a".repeat(64),
      metaJson: { ticketKey: "UGURPAY-123" },
    });
    expect(AuditEvent.safeParse(event).success).toBe(true);
    expect(event.seq).toBe(7);
    expect(event.at).toBe("2026-08-08T11:20:00.000Z");
  });

  it("defaults a NULL metaJson to an empty object, never to undefined", () => {
    const event = toAuditEvent({
      seq: 1n,
      at,
      actor: "maestro-worker",
      action: "RUN_CLOSED",
      subject: "UGURPAY-123",
      prevHash: "genesis",
      hash: "b".repeat(64),
      metaJson: null,
    });
    expect(event.meta).toEqual({});
  });

  it("maps an LlmCall row, converting Decimal usd", () => {
    const call = toLlmCallLog({
      at,
      runId: "run-ugurpay-123",
      role: "engineer",
      variantId: "engineer-web",
      driver: "anthropic-direct",
      model: "claude-opus-5",
      tokensIn: 10,
      tokensOut: 2,
      cachePct: 50,
      usd: { toNumber: () => 1.5 },
      dataClass: "dahili",
    });
    expect(LlmCallLog.safeParse(call).success).toBe(true);
    expect(call.usd).toBe(1.5);
  });

  it("maps a JournalEntry row and omits cost when the column is NULL", () => {
    const entry = toJournalEntry({
      runId: "run-ugurpay-123",
      seq: 0,
      at,
      actor: "system",
      kind: "intake",
      title: "Ticket alındı",
      detail: "",
      costJson: null,
    });
    expect(entry.cost).toBeUndefined();
  });

  it("maps a WorkflowRun row into WorkflowRunState", () => {
    const state = toWorkflowRunState({
      id: "run-ugurpay-123",
      ticketKey: "UGURPAY-123",
      step: "11",
      status: "gate",
      risk: "dusuk",
      startedAt: at,
      updatedAt: at,
    });
    expect(WorkflowRunState.safeParse(state).success).toBe(true);
  });

  it("maps a global ParamVersion row to a null scopeRef", () => {
    const change = toParamChange({
      key: "gates.risk_tiers",
      scopeRef: "",
      version: 4,
      valueJson: { dusuk: ["5", "12"] },
      changedBy: "ugur.yildiz@ugurbank.local",
      approvedBy: "mert.demir@ugurbank.local",
      at,
    });
    expect(ParamChange.safeParse(change).success).toBe(true);
    expect(change.scopeRef).toBeNull();
  });
});

describe("RoutingRule.projectKey mapping ('*' <-> NULL)", () => {
  it("reads NULL as the contract's org-wide marker", () => {
    expect(toContractProjectKey(null)).toBe(ORG_WIDE_PROJECT_KEY);
    expect(toContractProjectKey("UGURPAY")).toBe("UGURPAY");
    expect(isOrgWideRule(null)).toBe(true);
    expect(isOrgWideRule("UGURPAY")).toBe(false);
  });

  it("writes the org-wide marker as NULL", () => {
    expect(toColumnProjectKey("*")).toBeNull();
    expect(toColumnProjectKey("UGURPAY")).toBe("UGURPAY");
  });

  it("refuses anything that is neither, instead of storing a dead rule", () => {
    expect(() => toColumnProjectKey("ugurpay")).toThrow(InvalidRuleProjectKeyError);
    expect(() => toColumnProjectKey("")).toThrow(InvalidRuleProjectKeyError);
    expect(() => toColumnProjectKey("**")).toThrow(InvalidRuleProjectKeyError);
  });
});

describe("append-only surface (M30/M33)", () => {
  function fakeDelegate(): Record<string, unknown> {
    return {
      create: () => Promise.resolve({}),
      createMany: () => Promise.resolve({ count: 0 }),
      findMany: () => Promise.resolve([]),
      findFirst: () => Promise.resolve(null),
      findUnique: () => Promise.resolve(null),
      count: () => Promise.resolve(0),
      aggregate: () => Promise.resolve({}),
      groupBy: () => Promise.resolve([]),
      update: () => Promise.resolve({}),
      updateMany: () => Promise.resolve({ count: 0 }),
      delete: () => Promise.resolve({}),
      deleteMany: () => Promise.resolve({ count: 0 }),
      upsert: () => Promise.resolve({}),
    };
  }

  const surface = appendOnly({
    auditLog: fakeDelegate(),
    journalEntry: fakeDelegate(),
  } as never);

  it("exposes the reading and appending methods", () => {
    for (const method of APPEND_ONLY_METHODS) {
      expect(typeof (surface.auditLog as Record<string, unknown>)[method], method).toBe("function");
      expect(typeof (surface.journalEntry as Record<string, unknown>)[method], method).toBe("function");
    }
  });

  it("does not carry a single mutating method at runtime either", () => {
    for (const table of [surface.auditLog, surface.journalEntry]) {
      for (const method of ["update", "updateMany", "delete", "deleteMany", "upsert"]) {
        expect(method in (table as object), method).toBe(false);
      }
    }
  });

  it("is frozen, so the narrowing cannot be widened again", () => {
    expect(Object.isFrozen(surface)).toBe(true);
    expect(Object.isFrozen(surface.auditLog)).toBe(true);
  });

  it("still forwards a read to the underlying delegate", async () => {
    let called = false;
    const wrapped = appendOnly({
      auditLog: { ...fakeDelegate(), count: () => { called = true; return Promise.resolve(3); } },
      journalEntry: fakeDelegate(),
    } as never);
    await expect((wrapped.auditLog as { count: () => Promise<number> }).count()).resolves.toBe(3);
    expect(called).toBe(true);
  });
});
