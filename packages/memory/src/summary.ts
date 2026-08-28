import { LivingSummary, type JournalEntry } from "@maestro/contracts";
import { keepNewest, renderBlocks, type TextBlock } from "./blocks.js";
import { MemoryArgumentError } from "./errors.js";
import type { JournalMasker } from "./masking.js";
import { digestLine, entryLine, utcInstant } from "./summary-format.js";

/** `contracts.LivingSummary.text` is capped at 8000 characters (M30). */
export const SUMMARY_MAX_CHARS = 8000;
export const DEFAULT_RECENT_COUNT = 12;
export const DEFAULT_LINE_CHARS = 200;
/** Below this a summary cannot carry its guaranteed sections. */
const MIN_MAX_CHARS = 400;

/**
 * Kinds whose newest entry *is* the current state of that concern, so an
 * older one of the same kind is superseded rather than lost.
 *
 * The frozen `JournalEntry` has no status field, so "still open" cannot be
 * read off a single entry. Rather than invent a resolution protocol on top of
 * a frozen contract, memory uses the one rule the journal does support: the
 * latest scan result is the scan result, the latest CI verdict is the CI
 * verdict. Those latest entries are the "open findings" the summary always
 * keeps.
 */
export const FINDING_KINDS = [
  "scan",
  "review",
  "test_review",
  "ci",
  "pii",
  "quota",
  "handover",
] as const;

const FINDING_KIND_SET: ReadonlySet<string> = new Set(FINDING_KINDS);

export interface SummaryOptions {
  /** Newest events kept verbatim. Default 12. */
  readonly recentCount?: number;
  /** Hard ceiling, never above 8000. */
  readonly maxChars?: number;
  /** Per-line clip. Default 200. */
  readonly lineChars?: number;
  /**
   * Optional runtime re-check that nothing unmasked reached the summary.
   * Entries that came out of `appendJournal` are masked already; this is for
   * callers that assembled entries some other way (M82).
   */
  readonly guard?: Pick<JournalMasker, "assertClean">;
}

/**
 * Share of the budget reserved for signed gate decisions (verifier O-5).
 *
 * Gate lines are the evidence half of the summary (M33/M34): who approved
 * what, and when. Under the old ladder they competed with the event log and
 * lost — 30 decisions came out as 3 lines. They now have a floor of their own
 * and are the last section to give way; what does not fit is *counted*, never
 * silently absent.
 */
const GATE_BUDGET_SHARE = 0.5;

/** Section worth, cheapest first. Guaranteed sections use `Infinity`. */
const VALUE = { earlier: 10, recent: 30, findings: 40, log: 10 } as const;

interface Level {
  readonly mode: "full" | "sections";
  readonly recent: number;
  readonly earlier: "full" | "digest" | "none";
  readonly lineChars: number;
}

/**
 * Degradation ladder. Rendering is attempted at each level in order and the
 * first result that fits the budget wins, which keeps the whole thing a pure
 * function of the journal: same entries in, same characters out.
 *
 * What is given up, in order: the full older log, then the number of recent
 * events, then the compressed remainder, then line width. The newest events,
 * the gate decisions and the open findings survive every level — that is the
 * retention rule of M30.
 */
function ladder(recent: number, lineChars: number): Level[] {
  const half = Math.max(3, Math.floor(recent / 2));
  return [
    { mode: "full", recent, earlier: "full", lineChars },
    { mode: "sections", recent, earlier: "digest", lineChars },
    { mode: "sections", recent: half, earlier: "digest", lineChars },
    { mode: "sections", recent: 3, earlier: "digest", lineChars: 120 },
    { mode: "sections", recent: 3, earlier: "none", lineChars: 80 },
    { mode: "sections", recent: 1, earlier: "none", lineChars: 60 },
  ];
}

/** Sorted copy; rejects the two shapes that would make a summary a lie. */
function normalise(runId: string, entries: readonly JournalEntry[]): JournalEntry[] {
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  const seen = new Set<number>();
  for (const entry of sorted) {
    if (entry.runId !== runId) {
      throw new MemoryArgumentError("living summary", `entry #${entry.seq} belongs to ${entry.runId}, not ${runId}`);
    }
    if (seen.has(entry.seq)) {
      throw new MemoryArgumentError("living summary", `duplicate journal seq #${entry.seq}`);
    }
    seen.add(entry.seq);
  }
  return sorted;
}

function header(runId: string, entries: readonly JournalEntry[]): string[] {
  const first = entries[0];
  const last = entries[entries.length - 1];
  if (first === undefined || last === undefined) {
    return [`run ${runId} · journal empty`];
  }
  return [
    `run ${runId} · journal #${first.seq}-#${last.seq} (${entries.length} entries)`,
    `window ${utcInstant(first.at)} → ${utcInstant(last.at)}`,
  ];
}

/**
 * One level of the ladder.
 *
 * `maxChars` is the caller's budget: the gate section is sized from it at
 * every level, so signed decisions get their reserved share whether the
 * summary is rendered wide or narrow. `fit` additionally makes the *other*
 * sections give way until the whole thing fits — the last-resort path.
 */
function render(
  runId: string,
  entries: readonly JournalEntry[],
  level: Level,
  maxChars: number,
  fit: boolean,
): string {
  const budget = fit ? maxChars : Infinity;
  const blocks: TextBlock[] = [{ lines: header(runId, entries), value: Infinity }];
  if (entries.length === 0) return renderBlocks(blocks, budget);

  if (level.mode === "full") {
    blocks.push({
      heading: () => "## log",
      lines: entries.map((entry) => entryLine(entry, level.lineChars)),
      value: VALUE.log,
    });
    return renderBlocks(blocks, budget);
  }

  const recentFrom = Math.max(0, entries.length - level.recent);
  const recent = entries.slice(recentFrom);
  const older = entries.slice(0, recentFrom);

  // Latest entry per finding kind; those already in `recent` are not repeated.
  const latestFinding = new Map<string, JournalEntry>();
  for (const entry of entries) {
    if (FINDING_KIND_SET.has(entry.kind)) latestFinding.set(entry.kind, entry);
  }
  const findings = [...latestFinding.values()]
    .filter((entry) => entry.seq < (recent[0]?.seq ?? Infinity))
    .sort((a, b) => a.seq - b.seq);

  // Gate decisions first, out of their own reserved budget, and never trimmed
  // afterwards by a longer event log.
  const olderGates = older.filter((entry) => entry.kind === "gate");
  if (olderGates.length > 0) {
    const gates = keepNewest(
      olderGates.map((entry) => entryLine(entry, level.lineChars)),
      Math.floor(maxChars * GATE_BUDGET_SHARE),
    );
    blocks.push({
      heading: () => "## gate decisions",
      lines: gates.kept,
      value: Infinity,
      ...(gates.dropped === 0
        ? {}
        : { note: `(${gates.dropped} earlier gate decisions omitted)` }),
    });
  }

  if (findings.length > 0) {
    blocks.push({
      heading: () => "## open findings (latest per kind)",
      lines: findings.map((entry) => entryLine(entry, level.lineChars)),
      value: VALUE.findings,
    });
  }

  if (recent.length > 0) {
    blocks.push({
      heading: (kept) => `## recent (last ${kept})`,
      lines: recent.map((entry) => entryLine(entry, level.lineChars)),
      value: VALUE.recent,
    });
  }

  if (level.earlier !== "none" && older.length > 0) {
    blocks.push({ heading: () => "## earlier", lines: [digestLine(older)], value: VALUE.earlier });
  }

  return renderBlocks(blocks, budget);
}

/**
 * The living summary (M30): a bounded, self-contained account of a ticket's
 * journal, regenerated from the journal itself.
 *
 * Deterministic on purpose. The same journal always produces the same string,
 * so the summary is testable, diffable, reproducible years later for an
 * auditor, and — crucially — it exists even when no model is reachable. The
 * optional model pass (`enrichLivingSummary`) only ever *adds* to it.
 */
export function buildLivingSummary(
  runId: string,
  entries: readonly JournalEntry[],
  options: SummaryOptions = {},
): LivingSummary {
  const recentCount = options.recentCount ?? DEFAULT_RECENT_COUNT;
  const lineChars = options.lineChars ?? DEFAULT_LINE_CHARS;
  if (!Number.isInteger(recentCount) || recentCount < 1) {
    throw new MemoryArgumentError("recentCount", "must be a positive integer");
  }
  if (!Number.isInteger(lineChars) || lineChars < 40) {
    throw new MemoryArgumentError("lineChars", "must be an integer of at least 40");
  }
  const maxChars = Math.min(options.maxChars ?? SUMMARY_MAX_CHARS, SUMMARY_MAX_CHARS);
  if (maxChars < MIN_MAX_CHARS) {
    throw new MemoryArgumentError("maxChars", `must be at least ${MIN_MAX_CHARS}`);
  }

  const sorted = normalise(runId, entries);
  const upToSeq = sorted[sorted.length - 1]?.seq ?? 0;

  // The ladder is the primary mechanism: the widest level that fits wins.
  const levels = ladder(recentCount, lineChars);
  let text = "";
  for (const level of levels) {
    text = render(runId, sorted, level, maxChars, false);
    if (text.length <= maxChars) break;
  }
  // A journal of pathological single entries can overflow even the narrowest
  // level. Then, and only then, the sections give way cheapest-first — the
  // compressed remainder before the recent events, the oldest recent event
  // before the newest, the gate decisions never (verifier D-14/O-5).
  if (text.length > maxChars) {
    text = render(runId, sorted, levels[levels.length - 1] as Level, maxChars, true);
  }

  options.guard?.assertClean(text, "living-summary");
  return LivingSummary.parse({ runId, upToSeq, text });
}
