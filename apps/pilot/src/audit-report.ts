import type { AuditEvent } from "@maestro/contracts";

/**
 * B13 — regulator report.
 *
 * The hash-chained audit trail (M33) is the bank's evidence that every decision
 * — who approved, what passed, what was rejected — happened and was not altered.
 * A regulator or an internal auditor asks for it as a FILE, scoped to a window
 * and often to one actor or one kind of action. This module is the pure part of
 * answering that: filter the events, page them, and serialise a page to CSV.
 * The pilot server wraps it in `/api/audit` (JSON) and `/api/audit.csv`
 * (download); the chain read stays the only source, so an export can never show
 * a record the trail does not contain.
 */

export interface AuditFilter {
  /** ISO lower bound on `at` (inclusive). */
  from?: string;
  /** ISO upper bound on `at` (inclusive). */
  to?: string;
  /** Exact actor match. */
  actor?: string;
  /** Exact action match. */
  action?: string;
  /** Case-insensitive substring over subject + actor + action. */
  q?: string;
}

/** Apply a filter to events, preserving their (sequence) order. */
export function filterAuditEvents(
  events: readonly AuditEvent[],
  filter: AuditFilter,
): AuditEvent[] {
  const q = filter.q?.trim().toLowerCase();
  return events.filter((e) => {
    if (filter.from !== undefined && e.at < filter.from) return false;
    if (filter.to !== undefined && e.at > filter.to) return false;
    if (filter.actor !== undefined && e.actor !== filter.actor) return false;
    if (filter.action !== undefined && e.action !== filter.action) return false;
    if (q !== undefined && q.length > 0) {
      const hay = `${e.subject} ${e.actor} ${e.action}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export interface AuditPageResult {
  /** Total events AFTER filtering (before paging) — for the "1–50 / 320" line. */
  total: number;
  /** The requested slice. */
  events: AuditEvent[];
  offset: number;
  limit: number;
}

/**
 * Filter then page. `limit` is clamped to [1, 500] and `offset` to ≥0 so a bad
 * query string can never ask for an unbounded or negative slice.
 */
export function pageAuditEvents(
  events: readonly AuditEvent[],
  filter: AuditFilter,
  offset: number,
  limit: number,
): AuditPageResult {
  const filtered = filterAuditEvents(events, filter);
  const safeLimit = Math.min(500, Math.max(1, Math.floor(limit) || 50));
  const safeOffset = Math.max(0, Math.floor(offset) || 0);
  return {
    total: filtered.length,
    events: filtered.slice(safeOffset, safeOffset + safeLimit),
    offset: safeOffset,
    limit: safeLimit,
  };
}

/** RFC-4180 field escaping: quote when the value holds a comma, quote or newline. */
function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

const CSV_HEADER = ["seq", "at", "actor", "action", "subject", "hash"] as const;

/**
 * Serialise events to CSV — one header row then one row per event, in the order
 * given. `meta` is intentionally omitted: it can carry arbitrary nested values
 * and the regulator columns are the fixed chain fields. The chain's own hash is
 * included so an auditor can tie a row back to the verified chain.
 */
export function auditEventsToCsv(events: readonly AuditEvent[]): string {
  const rows = [CSV_HEADER.join(",")];
  for (const e of events) {
    rows.push(
      [
        String(e.seq),
        e.at,
        csvField(e.actor),
        csvField(e.action),
        csvField(e.subject),
        e.hash,
      ].join(","),
    );
  }
  // Trailing newline: many CSV readers expect the final record to be terminated.
  return `${rows.join("\n")}\n`;
}
