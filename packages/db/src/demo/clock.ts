/**
 * The demo dataset's clock and identity helpers.
 *
 * Everything in `src/demo/**` is derived from `DEMO_NOW`, so re-running the
 * seed produces byte-identical rows: the dataset is a fixture, not random
 * noise, and a diff in the database is a diff in the code.
 */

/** The mock's "now": 8 Aug 2026, 14:20 Istanbul time. */
export const DEMO_NOW = new Date("2026-08-08T11:20:00.000Z");

const HOUR = 3_600_000;

/** A timestamp `hours` before `DEMO_NOW` (negative = after). */
export function ago(hours: number): Date {
  return new Date(DEMO_NOW.getTime() - hours * HOUR);
}

/** Istanbul wall-clock helper for the hand-transcribed mock journal. */
export function ist(iso: string): Date {
  return new Date(`${iso}+03:00`);
}

/** Deterministic run id derived from the ticket key (RunId: opaque, min 8). */
export function demoRunId(ticketKey: string): string {
  return `run-${ticketKey.toLowerCase()}`;
}
