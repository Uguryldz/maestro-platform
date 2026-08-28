/**
 * Formatting helpers. Every one of them returns either a locale-formatted
 * number/date (no words) or a catalog key plus params for the caller to
 * translate — none of them ever returns a hard-coded sentence.
 */

export interface AgeLabel {
  readonly key: string;
  readonly params: Record<string, string>;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long ago `iso` was, as a catalog key + params: `age.days` / `age.hours` /
 * `age.minutes` / `age.now`. Returns null for an unparseable timestamp so the
 * caller can show an em dash instead of "NaN gün".
 */
export function ageLabel(iso: string | null | undefined, now: number = Date.now()): AgeLabel | null {
  if (iso === null || iso === undefined) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;

  const elapsed = Math.max(0, now - then);
  if (elapsed >= DAY) {
    return { key: "age.days", params: { n: String(Math.floor(elapsed / DAY)) } };
  }
  if (elapsed >= HOUR) {
    return { key: "age.hours", params: { n: String(Math.floor(elapsed / HOUR)) } };
  }
  if (elapsed >= MINUTE) {
    return { key: "age.minutes", params: { n: String(Math.floor(elapsed / MINUTE)) } };
  }
  return { key: "age.now", params: {} };
}

/** Absolute timestamp in the viewer's locale; empty string when unparseable. */
export function dateTimeLabel(iso: string | null | undefined, locale: string): string {
  if (iso === null || iso === undefined) return "";
  const value = Date.parse(iso);
  if (Number.isNaN(value)) return "";
  return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(value);
}

/** File size in KiB/MiB, digits only — the unit is a catalog key. */
export function byteSize(bytes: number): { readonly value: string; readonly key: string } {
  if (bytes >= 1024 * 1024) {
    return { value: (bytes / (1024 * 1024)).toFixed(1), key: "unit.mib" };
  }
  if (bytes >= 1024) {
    return { value: (bytes / 1024).toFixed(0), key: "unit.kib" };
  }
  return { value: String(bytes), key: "unit.b" };
}

/** Short sha for display: first 8 and last 4 of a hex digest. */
export function shortHash(hex: string): string {
  return hex.length <= 16 ? hex : `${hex.slice(0, 8)}…${hex.slice(-4)}`;
}
