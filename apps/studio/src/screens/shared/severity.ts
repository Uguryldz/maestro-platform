import type { BadgeTone } from "../../ui/index.ts";

/**
 * Severity ordering shared by the security and issues screens.
 *
 * The vocabulary is `ScanSeverity` from packages/contracts (info · low · medium
 * · high · critical). Findings are sorted most-severe first and NOTHING is
 * filtered out by default: a low finding that is hidden is a low finding nobody
 * fixes, and a screen that quietly drops rows misrepresents the scan result.
 *
 * An unrecognised severity sorts as `unknown` — ABOVE low, not below it. An
 * unclassified finding is not a harmless one, so it must not sink to the bottom
 * of the list where nobody reads it.
 */
export type Severity = "critical" | "high" | "medium" | "low" | "info" | "unknown";

const ORDER: Readonly<Record<Severity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  unknown: 3,
  low: 4,
  info: 5,
};

const KNOWN: readonly string[] = ["critical", "high", "medium", "low", "info"];

/** Normalise a wire value; anything unrecognised becomes `unknown`. */
export function toSeverity(raw: unknown): Severity {
  if (typeof raw !== "string") return "unknown";
  const value = raw.toLowerCase();
  return KNOWN.includes(value) ? (value as Severity) : "unknown";
}

export function severityRank(raw: unknown): number {
  return ORDER[toSeverity(raw)];
}

export function severityTone(raw: unknown): BadgeTone {
  switch (toSeverity(raw)) {
    case "critical":
      return "red";
    case "high":
      return "orange";
    case "medium":
      return "amber";
    case "low":
    case "info":
      return "gray";
    default:
      return "purple";
  }
}

/** Sort a copy of `rows` most-severe first, keeping input order within a tier. */
export function bySeverity<T>(rows: readonly T[], of: (row: T) => unknown): readonly T[] {
  return [...rows].sort((a, b) => severityRank(of(a)) - severityRank(of(b)));
}
