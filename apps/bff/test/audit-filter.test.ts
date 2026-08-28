import { describe, expect, it } from "vitest";
import type { AuditEvent } from "@maestro/contracts";
import {
  AUDIT_CSV_HEADER,
  auditCsvFileName,
  auditEventsToCsv,
  filterAuditEvents,
} from "../src/audit-filter.js";

/**
 * The pure half of the B13 regulator report, Studio edition. The semantics are
 * the pilot's (apps/pilot/src/audit-report.ts): inclusive ISO window on `at`,
 * exact actor/action, case-insensitive needle over subject+actor+action, and
 * RFC-4180 CSV with the fixed chain columns.
 */

function event(over: Partial<AuditEvent>): AuditEvent {
  return {
    seq: 1,
    at: "2026-08-09T09:00:00.000Z",
    actor: "maestro-worker",
    action: "RUN_STARTED",
    subject: "UGURPAY-501",
    prevHash: "genesis",
    hash: "a".repeat(64),
    meta: {},
    ...over,
  };
}

describe("filterAuditEvents", () => {
  const TRAIL = [
    event({ seq: 1, at: "2026-08-07T10:00:00.000Z", actor: "ayse@corp", action: "GATE_APPROVE" }),
    event({ seq: 2, at: "2026-08-08T10:00:00.000Z", actor: "maestro-worker", action: "RUN_STARTED" }),
    event({ seq: 3, at: "2026-08-09T10:00:00.000Z", actor: "ayse@corp", action: "GATE_REJECT", subject: "UGURWEB-104" }),
  ];

  it("passes everything through an empty filter, in order", () => {
    expect(filterAuditEvents(TRAIL, {})).toEqual(TRAIL);
    // Nullable fields (the read-model shape) mean the same as absent ones.
    expect(
      filterAuditEvents(TRAIL, { from: null, to: null, actor: null, action: null, subject: null, q: null }),
    ).toEqual(TRAIL);
  });

  it("treats both time bounds as inclusive", () => {
    const window = filterAuditEvents(TRAIL, {
      from: "2026-08-08T10:00:00.000Z",
      to: "2026-08-09T10:00:00.000Z",
    });
    expect(window.map((e) => e.seq)).toEqual([2, 3]);
  });

  it("keeps a whole day when the bounds are widened to its edges", () => {
    const day = filterAuditEvents(TRAIL, {
      from: "2026-08-08T00:00:00.000Z",
      to: "2026-08-08T23:59:59.999Z",
    });
    expect(day.map((e) => e.seq)).toEqual([2]);
  });

  it("matches actor and action exactly, never by substring", () => {
    expect(filterAuditEvents(TRAIL, { actor: "ayse@corp" }).map((e) => e.seq)).toEqual([1, 3]);
    expect(filterAuditEvents(TRAIL, { actor: "ayse" })).toEqual([]);
    expect(filterAuditEvents(TRAIL, { action: "GATE_APPROVE" }).map((e) => e.seq)).toEqual([1]);
  });

  it("matches subject exactly (the pre-existing /studio/audit param)", () => {
    expect(filterAuditEvents(TRAIL, { subject: "UGURWEB-104" }).map((e) => e.seq)).toEqual([3]);
  });

  it("searches subject, actor and action case-insensitively with q", () => {
    expect(filterAuditEvents(TRAIL, { q: "ugurweb" }).map((e) => e.seq)).toEqual([3]);
    expect(filterAuditEvents(TRAIL, { q: "AYSE" }).map((e) => e.seq)).toEqual([1, 3]);
    expect(filterAuditEvents(TRAIL, { q: "gate_" }).map((e) => e.seq)).toEqual([1, 3]);
    expect(filterAuditEvents(TRAIL, { q: "yok-boyle-birsey" })).toEqual([]);
  });

  it("combines every clause with AND", () => {
    const both = filterAuditEvents(TRAIL, {
      from: "2026-08-08T00:00:00.000Z",
      actor: "ayse@corp",
      q: "reject",
    });
    expect(both.map((e) => e.seq)).toEqual([3]);
  });
});

describe("auditEventsToCsv", () => {
  it("writes the fixed header, one row per event and a trailing newline", () => {
    const csv = auditEventsToCsv([event({})]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe(AUDIT_CSV_HEADER.join(","));
    expect(lines[1]).toBe(
      `1,2026-08-09T09:00:00.000Z,maestro-worker,RUN_STARTED,UGURPAY-501,${"a".repeat(64)}`,
    );
    expect(csv.endsWith("\n")).toBe(true);
  });

  it("escapes commas, quotes and newlines per RFC-4180", () => {
    const csv = auditEventsToCsv([
      event({ actor: 'ay"se, PO', subject: "satır\nkıran-konu" }),
    ]);
    expect(csv).toContain('"ay""se, PO"');
    expect(csv).toContain('"satır\nkıran-konu"');
  });

  it("omits meta on purpose — the regulator columns are the chain fields", () => {
    const csv = auditEventsToCsv([event({ meta: { gizli: "deger" } })]);
    expect(csv).not.toContain("gizli");
    expect(csv).not.toContain("deger");
  });
});

describe("auditCsvFileName", () => {
  it("stamps the injected clock's date", () => {
    expect(auditCsvFileName(new Date("2026-08-09T09:00:00.000Z"))).toBe(
      "maestro-denetim-2026-08-09.csv",
    );
  });
});
