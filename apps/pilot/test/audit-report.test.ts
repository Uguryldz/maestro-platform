import type { AuditEvent } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import {
  auditEventsToCsv,
  filterAuditEvents,
  pageAuditEvents,
} from "../src/audit-report.js";

/**
 * B13 — regulator report. These pin the pure filter/page/CSV logic the pilot's
 * /api/audit(.csv) routes wrap: the window/actor/action filters, the paging
 * clamps, and RFC-4180 CSV escaping — so a regulator export stays faithful and
 * bounded no matter what the query string asks for.
 */

function evt(over: Partial<AuditEvent>): AuditEvent {
  return {
    seq: 1,
    at: "2026-08-10T10:00:00.000Z",
    actor: "maestro-runner",
    action: "GATE_APPROVE",
    subject: "UGURPAY-1",
    prevHash: "0".repeat(64),
    hash: "a".repeat(64),
    meta: {},
    ...over,
  } as AuditEvent;
}

const EVENTS: AuditEvent[] = [
  evt({ seq: 1, at: "2026-08-10T09:00:00.000Z", actor: "ayse@corp", action: "GATE_APPROVE", subject: "UGURPAY-1" }),
  evt({ seq: 2, at: "2026-08-11T09:00:00.000Z", actor: "mehmet@corp", action: "GATE_REJECT", subject: "UGURPAY-2" }),
  evt({ seq: 3, at: "2026-08-12T09:00:00.000Z", actor: "ayse@corp", action: "PR_MERGED", subject: "UGURPAY-3" }),
];

describe("filterAuditEvents", () => {
  it("filters by actor", () => {
    const out = filterAuditEvents(EVENTS, { actor: "ayse@corp" });
    expect(out.map((e) => e.seq)).toEqual([1, 3]);
  });

  it("filters by action", () => {
    const out = filterAuditEvents(EVENTS, { action: "GATE_REJECT" });
    expect(out.map((e) => e.seq)).toEqual([2]);
  });

  it("filters by an inclusive ISO date window", () => {
    const out = filterAuditEvents(EVENTS, {
      from: "2026-08-11T00:00:00.000Z",
      to: "2026-08-11T23:59:59.999Z",
    });
    expect(out.map((e) => e.seq)).toEqual([2]);
  });

  it("filters by a substring query over subject/actor/action", () => {
    expect(filterAuditEvents(EVENTS, { q: "merged" }).map((e) => e.seq)).toEqual([3]);
    expect(filterAuditEvents(EVENTS, { q: "ugurpay-2" }).map((e) => e.seq)).toEqual([2]);
  });

  it("returns everything for an empty filter", () => {
    expect(filterAuditEvents(EVENTS, {})).toHaveLength(3);
  });
});

describe("pageAuditEvents", () => {
  it("reports total before paging and returns the slice", () => {
    const page = pageAuditEvents(EVENTS, {}, 1, 1);
    expect(page.total).toBe(3);
    expect(page.events.map((e) => e.seq)).toEqual([2]);
    expect(page.offset).toBe(1);
    expect(page.limit).toBe(1);
  });

  it("clamps a bad limit/offset to safe bounds", () => {
    const page = pageAuditEvents(EVENTS, {}, -5, 100_000);
    expect(page.offset).toBe(0);
    expect(page.limit).toBe(500);
    expect(page.events).toHaveLength(3);
  });
});

describe("auditEventsToCsv", () => {
  it("writes a header row and one row per event", () => {
    const csv = auditEventsToCsv(EVENTS);
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe("seq,at,actor,action,subject,hash");
    expect(lines).toHaveLength(4); // header + 3
    expect(lines[1]).toContain("ayse@corp");
  });

  it("escapes commas and quotes per RFC-4180", () => {
    const csv = auditEventsToCsv([
      evt({ subject: 'has,comma and "quote"', actor: "x@corp" }),
    ]);
    expect(csv).toContain('"has,comma and ""quote"""');
  });

  it("ends with a trailing newline", () => {
    expect(auditEventsToCsv(EVENTS).endsWith("\n")).toBe(true);
  });
});
