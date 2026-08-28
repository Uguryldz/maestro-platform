import { describe, expect, it } from "vitest";
import { buildDemoDataset, DEMO_TICKETS, demoRunId } from "../src/index.js";

/**
 * A run has a window: [startedAt, updatedAt]. Everything that belongs to the
 * run — journal entries, step events, gateway calls — has to fall inside it,
 * and the journal has to move forward. These used to be assumptions; the demo
 * violated all four of them somewhere.
 */
const data = buildDemoDataset();

const runByTicket = new Map(data.runs.map((run) => [String(run.ticketKey), run]));
const windowOf = (ticketKey: string): { startedAt: number; updatedAt: number } => {
  const run = runByTicket.get(ticketKey);
  if (run === undefined) throw new Error(`no run for ${ticketKey}`);
  return {
    startedAt: (run.startedAt as Date).getTime(),
    updatedAt: (run.updatedAt as Date).getTime(),
  };
};

describe("temporal invariants", () => {
  it("never lets a run be updated before it started", () => {
    for (const run of data.runs) {
      expect(
        (run.updatedAt as Date).getTime(),
        `${String(run.ticketKey)} updatedAt < startedAt`,
      ).toBeGreaterThanOrEqual((run.startedAt as Date).getTime());
    }
  });

  it("keeps every journal entry inside its run's window, in order", () => {
    const byRun = new Map<string, { seq: number; at: number }[]>();
    for (const entry of data.journal) {
      const list = byRun.get(entry.runId) ?? [];
      list.push({ seq: entry.seq, at: (entry.at as Date).getTime() });
      byRun.set(entry.runId, list);
    }
    expect(byRun.size).toBe(22);
    for (const ticket of DEMO_TICKETS) {
      const { startedAt, updatedAt } = windowOf(ticket.key);
      const entries = (byRun.get(demoRunId(ticket.key)) ?? []).sort((a, b) => a.seq - b.seq);
      expect(entries.map((e) => e.seq), ticket.key).toEqual(entries.map((_, i) => i));
      for (const entry of entries) {
        expect(entry.at, `${ticket.key}#${entry.seq} before startedAt`).toBeGreaterThanOrEqual(startedAt);
        expect(entry.at, `${ticket.key}#${entry.seq} after updatedAt`).toBeLessThanOrEqual(updatedAt);
      }
      for (let i = 1; i < entries.length; i++) {
        expect(entries[i]?.at, `${ticket.key} journal goes backwards`).toBeGreaterThanOrEqual(
          entries[i - 1]?.at ?? 0,
        );
      }
    }
  });

  it("never records a step event before its run started", () => {
    for (const event of data.stepEvents) {
      const ticketKey = String(event.runId).replace(/^run-/, "").toUpperCase();
      const { startedAt, updatedAt } = windowOf(ticketKey);
      const at = (event.at as Date).getTime();
      expect(at, `${ticketKey} step ${String(event.step)} before startedAt`).toBeGreaterThanOrEqual(startedAt);
      expect(at, `${ticketKey} step ${String(event.step)} after updatedAt`).toBeLessThanOrEqual(updatedAt);
    }
  });

  it("bills every llm call to a run that was alive at the time", () => {
    for (const call of data.llmCalls) {
      const ticketKey = String(call.runId).replace(/^run-/, "").toUpperCase();
      const { startedAt, updatedAt } = windowOf(ticketKey);
      const at = (call.at as Date).getTime();
      expect(at, `${ticketKey} llm call before startedAt`).toBeGreaterThanOrEqual(startedAt);
      expect(at, `${ticketKey} llm call after updatedAt`).toBeLessThanOrEqual(updatedAt);
    }
  });
});

