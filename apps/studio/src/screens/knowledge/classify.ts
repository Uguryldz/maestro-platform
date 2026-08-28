import type { DataClass } from "@maestro/contracts";

/**
 * Data-class handling for the knowledge library.
 *
 * RULE (fail-closed): a record whose `dataClass` is missing, null, or not one
 * of the known values is treated as **gizli** — the most restrictive class —
 * NOT as `acik`. An untagged record is an unclassified record, and guessing
 * "public" for it is how confidential documents leak.
 *
 * `gizli` records are DROPPED from this channel rather than masked: the
 * knowledge list is a browsing surface, and there is no partial view of a
 * confidential document that is both useful and safe here. The screen reports
 * how many were withheld so the omission is visible, never silent.
 */

/**
 * A knowledge hit as `GET /studio/knowledge` returns it.
 *
 * `dataClass` is typed `unknown` rather than `DataClass` on purpose. The BFF
 * declares it required and never defaulted, but this is the boundary where a
 * wire value becomes a trusted one, and typing it as already-valid would make
 * the fail-closed check below look redundant and invite its removal.
 */
export interface KnowledgeDoc {
  readonly id: string;
  readonly title: string;
  readonly snippet: string;
  readonly source: string;
  readonly score: number;
  readonly appId: string | null;
  readonly updatedBy: string;
  readonly updatedAt: string;
  readonly dataClass?: unknown;
}

const KNOWN: readonly string[] = ["acik", "dahili", "gizli"];

/** Normalise whatever the wire produced into a DataClass, failing closed. */
export function resolveDataClass(raw: unknown): DataClass {
  if (typeof raw === "string" && KNOWN.includes(raw)) return raw as DataClass;
  return "gizli";
}

/** True when the record may be listed in this channel. */
export function isVisibleInChannel(raw: unknown): boolean {
  return resolveDataClass(raw) !== "gizli";
}

export interface Partitioned<T> {
  readonly visible: readonly T[];
  /** How many records were withheld because they resolved to `gizli`. */
  readonly withheld: number;
}

/** Split records into the ones this channel may show and a withheld count. */
export function partitionByDataClass<T extends { readonly dataClass?: unknown }>(
  records: readonly T[],
): Partitioned<T> {
  const visible = records.filter((record) => isVisibleInChannel(record.dataClass));
  return { visible, withheld: records.length - visible.length };
}
