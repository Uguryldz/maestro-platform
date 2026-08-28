import type { AuditEvent } from "@maestro/contracts";

/**
 * The auditor's window onto the trail (B13, Studio edition).
 *
 * The pilot's regulator report (apps/pilot/src/audit-report.ts) established the
 * contract: filter the chain's events by a time window, an exact actor, an
 * exact action and a free-text needle, then serialise the whole filtered
 * window to RFC-4180 CSV. This is the BFF's own copy of that pure logic — a
 * copy rather than an import, because the pilot is a separate app and a BFF
 * that reaches into another app's source tree couples two deployables that
 * ship apart. The chain read stays the only source, so an export can never
 * show a record the trail does not contain.
 */

export interface AuditEventFilter {
  /** ISO lower bound on `at` (inclusive). */
  readonly from?: string | null;
  /** ISO upper bound on `at` (inclusive). */
  readonly to?: string | null;
  /** Exact actor match. */
  readonly actor?: string | null;
  /** Exact action match. */
  readonly action?: string | null;
  /** Exact subject match (the existing `/studio/audit` param, kept). */
  readonly subject?: string | null;
  /** Case-insensitive substring over subject + actor + action. */
  readonly q?: string | null;
}

/**
 * Apply a filter to events, preserving their order. The time bounds compare
 * ISO strings lexically — correct for the chain because every `at` is an ISO
 * instant — and both bounds are inclusive, so a caller that widens a date to
 * `T00:00:00.000Z` / `T23:59:59.999Z` gets the whole day.
 */
export function filterAuditEvents(
  events: readonly AuditEvent[],
  filter: AuditEventFilter,
): AuditEvent[] {
  const from = filter.from ?? null;
  const to = filter.to ?? null;
  const actor = filter.actor ?? null;
  const action = filter.action ?? null;
  const subject = filter.subject ?? null;
  const q = filter.q?.trim().toLowerCase() ?? "";

  return events.filter((e) => {
    if (from !== null && e.at < from) return false;
    if (to !== null && e.at > to) return false;
    if (actor !== null && e.actor !== actor) return false;
    if (action !== null && e.action !== action) return false;
    if (subject !== null && e.subject !== subject) return false;
    if (q !== "") {
      const hay = `${e.subject} ${e.actor} ${e.action}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** RFC-4180 field escaping: quote when the value holds a comma, quote or newline. */
function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export const AUDIT_CSV_HEADER = ["seq", "at", "actor", "action", "subject", "hash"] as const;

/**
 * Serialise events to CSV — one header row then one row per event, in the
 * order given. `meta` is intentionally omitted: it can carry arbitrary nested
 * values and the regulator columns are the fixed chain fields. The chain's own
 * hash is included so an auditor can tie a row back to the verified chain.
 */
export function auditEventsToCsv(events: readonly AuditEvent[]): string {
  const rows = [AUDIT_CSV_HEADER.join(",")];
  for (const e of events) {
    rows.push(
      [String(e.seq), e.at, csvField(e.actor), csvField(e.action), csvField(e.subject), e.hash].join(
        ",",
      ),
    );
  }
  // Trailing newline: many CSV readers expect the final record to be terminated.
  return `${rows.join("\n")}\n`;
}

/** The download name, stamped with the (injected) clock's date — never `Date.now`. */
export function auditCsvFileName(now: Date): string {
  return `maestro-denetim-${now.toISOString().slice(0, 10)}.csv`;
}
