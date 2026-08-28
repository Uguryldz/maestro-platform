import { PII_TYPES, type MaskCounts, type PiiType } from "./types.js";

/** Mutable accumulator used while walking a payload. */
export interface CountAccumulator {
  occurrences: number;
  fields: number;
  readonly byType: Map<PiiType, number>;
}

export function newAccumulator(): CountAccumulator {
  return { occurrences: 0, fields: 0, byType: new Map() };
}

export function countOccurrence(acc: CountAccumulator, type: PiiType): void {
  acc.occurrences += 1;
  acc.byType.set(type, (acc.byType.get(type) ?? 0) + 1);
}

export function countField(acc: CountAccumulator): void {
  acc.fields += 1;
}

/** Freeze the accumulator into the audit-safe shape, types in declared order. */
export function toCounts(acc: CountAccumulator): MaskCounts {
  const byType: Partial<Record<PiiType, number>> = {};
  for (const type of PII_TYPES) {
    const n = acc.byType.get(type);
    if (n !== undefined) byType[type] = n;
  }
  return { occurrences: acc.occurrences, fields: acc.fields, byType };
}

export const EMPTY_COUNTS: MaskCounts = { occurrences: 0, fields: 0, byType: {} };

/**
 * Meta for an M33 `PII_MASKED` audit row. Studio renders it through i18n
 * ("PII_MASKED · 3 alan"); this returns numbers and type names only, so an
 * audit export can never become a PII export.
 */
export function toAuditMeta(counts: MaskCounts): Record<string, unknown> {
  return {
    maskedOccurrences: counts.occurrences,
    maskedFields: counts.fields,
    maskedTypes: PII_TYPES.filter((t) => counts.byType[t] !== undefined),
  };
}
