import { useT } from "../../i18n/I18nProvider.tsx";

/**
 * A parameter value is `unknown` on the wire (it may be a string, a number, a
 * boolean or a whole JSON object), and it is CONFIGURATION, not prose — the
 * operator has to see it byte for byte to approve it. Rendering it therefore
 * does not go through the catalog; what does go through the catalog is every
 * label around it. JSON is stringified with two-space indent so a nested gate
 * set stays readable in the four-eyes diff.
 */
export function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "—";
  return JSON.stringify(value, null, 2);
}

/**
 * Elapsed time as a translated phrase. The catalog owns the wording (Turkish
 * needs "16 gün 2 saat", English "16d 2h"), so this only decides which key and
 * which numbers — a screen never concatenates a unit onto a number itself.
 */
export function useDuration(): (hours: number) => string {
  const t = useT();
  return (hours: number) => {
    if (!Number.isFinite(hours) || hours < 0) return "—";
    const days = Math.floor(hours / 24);
    const rest = Math.floor(hours % 24);
    if (days === 0) return t("duration.hours", { hours: String(rest) });
    return t("duration.days_hours", { days: String(days), hours: String(rest) });
  };
}
