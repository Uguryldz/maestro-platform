import { JournalEntry } from "@maestro/contracts";
import { defaultPiiPolicy, loadPiiPolicy, type MaskCounts } from "@maestro/pii";
import { createJournalMasker, type JournalMasker } from "../../src/masking.js";
import type { Clock } from "../../src/types.js";

export const RUN_ID = "run-UGURPAY-1234";
export const TICKET_KEY = "UGURPAY-1234";
/** Synthetic (M95): a made-up address, not a real one. */
export const SAMPLE_EMAIL = "ayse.yilmaz@ornek-banka.example";

export function testMasker(
  onMasked?: (counts: MaskCounts, dataClass: string) => void,
): JournalMasker {
  return createJournalMasker({
    policy: loadPiiPolicy(defaultPiiPolicy()),
    dataClass: "gizli",
    ...(onMasked ? { onMasked } : {}),
  });
}

export function fixedClock(iso: string): Clock {
  return { now: () => iso };
}

/** A clock that hands out one timestamp per call, then repeats the last one. */
export function scriptedClock(times: readonly string[]): Clock {
  let index = 0;
  return {
    now: () => {
      const value = times[Math.min(index, times.length - 1)] as string;
      index += 1;
      return value;
    },
  };
}

export interface EntryInput {
  readonly seq: number;
  readonly kind?: JournalEntry["kind"];
  readonly actor?: JournalEntry["actor"];
  readonly title?: string;
  readonly detail?: string;
  readonly at?: string;
  readonly runId?: string;
}

/** A ready-made (already masked) journal entry for summary/bootstrap tests. */
export function entry(input: EntryInput): JournalEntry {
  const minute = String(input.seq % 60).padStart(2, "0");
  const hour = String(Math.floor(input.seq / 60) % 24).padStart(2, "0");
  return JournalEntry.parse({
    runId: input.runId ?? RUN_ID,
    seq: input.seq,
    at: input.at ?? `2026-08-08T${hour}:${minute}:00+03:00`,
    actor: input.actor ?? "ai",
    kind: input.kind ?? "engineering",
    title: input.title ?? `event ${input.seq}`,
    detail: input.detail ?? "",
  });
}
