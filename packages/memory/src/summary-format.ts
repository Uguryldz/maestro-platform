import type { JournalEntry } from "@maestro/contracts";

/** Collapse a possibly multi-line journal field to a single spaced line. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Clip to `max` characters, marking the cut so a reader knows it happened. */
export function clip(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/**
 * Canonical UTC form of an instant.
 *
 * The journal stores whatever offset the caller wrote (`+03:00`), Postgres
 * hands it back as `Z`, and a summary that printed either would produce two
 * different documents for one journal either side of a restart (verifier
 * O-8). Determinism is the whole promise of this artefact, so every rendered
 * timestamp is normalised. An unparseable value is printed as it stands — a
 * summary is not the place to discover a broken timestamp.
 */
export function utcInstant(iso: string): string {
  const millis = Date.parse(iso);
  return Number.isNaN(millis) ? iso : new Date(millis).toISOString();
}

/**
 * One entry, one line: `#12 2026-08-08T06:00:00.000Z ai/gate: title — detail`.
 * The seq is first because it is the only stable handle a reader (or a later
 * entry) has on an event.
 */
export function entryLine(entry: JournalEntry, lineChars: number): string {
  const head = `#${entry.seq} ${utcInstant(entry.at)} ${entry.actor}/${entry.kind}: ${oneLine(entry.title)}`;
  const detail = oneLine(entry.detail);
  return clip(detail.length === 0 ? head : `${head} — ${detail}`, lineChars);
}

/** Counts per kind, in descending count order then alphabetical — stable. */
export function kindCounts(entries: readonly JournalEntry[]): string {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, count]) => `${kind} ${count}`)
    .join(", ");
}

/** The compressed form of the entries that did not survive in full. */
export function digestLine(entries: readonly JournalEntry[]): string {
  const first = entries[0];
  const last = entries[entries.length - 1];
  if (first === undefined || last === undefined) return "";
  const span = first.seq === last.seq ? `#${first.seq}` : `#${first.seq}-#${last.seq}`;
  return `${span} (${entries.length} entries): ${kindCounts(entries)}`;
}
