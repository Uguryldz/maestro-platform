import type { AuditEvent } from "@maestro/contracts";
import { AuditChain, InMemoryAuditStore, type AppendInput, type Clock } from "../src/index.js";

/** Deterministic clock: every read advances by a fixed step. */
export function fixedClock(startIso: string, stepMs = 1_000): Clock {
  let current = Date.parse(startIso);
  return {
    now(): Date {
      const date = new Date(current);
      current += stepMs;
      return date;
    },
  };
}

export const SAMPLE_INPUTS: AppendInput[] = [
  { actor: "maestro-worker", action: "RUN_STARTED", subject: "UGURPAY-101", meta: { runId: "run-0001" } },
  { actor: "maestro-worker", action: "GATE_OPEN", subject: "UGURPAY-101", meta: { gate: "analysis" } },
  { actor: "po.demir@ugurbank.corp", action: "GATE_APPROVE", subject: "UGURPAY-101", meta: { gate: "analysis" } },
  { actor: "ai-via:po.demir@ugurbank.corp", action: "ASSIGN_APP", subject: "UGURPAY-101", meta: { appId: "ugurweb" } },
  { actor: "maestro-runner", action: "SANDBOX_CREATE", subject: "run-0001", meta: {} },
];

export interface SampleChain {
  readonly chain: AuditChain;
  readonly store: InMemoryAuditStore;
  readonly events: AuditEvent[];
}

/** A five-record chain written at one-second intervals from a fixed instant. */
export async function sampleChain(startIso = "2026-08-08T09:00:00.000Z"): Promise<SampleChain> {
  const store = new InMemoryAuditStore();
  const chain = new AuditChain({ store, clock: fixedClock(startIso) });
  const events = await chain.appendMany(SAMPLE_INPUTS);
  return { chain, store, events };
}

/** Structured clone of a record list — tampering tests must not mutate shared state. */
export function clone(events: readonly AuditEvent[]): AuditEvent[] {
  return events.map((event) => structuredClone(event) as AuditEvent);
}

export const SAMPLE_DAYS = ["2026-08-08", "2026-08-09", "2026-08-10"] as const;

export interface MultiDayChain extends SampleChain {
  /** `days[i]` is the slice of the chain that falls on `SAMPLE_DAYS[i]`. */
  readonly days: AuditEvent[][];
}

/** One continuous chain spread over consecutive UTC days — the input a series of anchors covers. */
export async function multiDayChain(days: readonly string[] = SAMPLE_DAYS): Promise<MultiDayChain> {
  const store = new InMemoryAuditStore();
  const chain = new AuditChain({ store });
  const slices: AuditEvent[][] = [];

  for (const [index, day] of days.entries()) {
    slices.push(
      await chain.appendMany([
        {
          actor: "maestro-worker",
          action: "RUN_STARTED",
          subject: `UGURPAY-${300 + index}`,
          at: `${day}T09:00:00.000Z`,
        },
        {
          actor: "po.demir@ugurbank.corp",
          action: "GATE_APPROVE",
          subject: `UGURPAY-${300 + index}`,
          at: `${day}T12:00:00.000Z`,
        },
        {
          actor: "maestro-worker",
          action: "RUN_CLOSED",
          subject: `UGURPAY-${300 + index}`,
          at: `${day}T17:00:00.000Z`,
        },
      ]),
    );
  }

  return { chain, store, events: slices.flat(), days: slices };
}
