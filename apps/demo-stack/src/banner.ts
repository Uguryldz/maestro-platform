import type { Locale } from "@maestro/contracts";
import type { SeedSummary } from "./seed/index.js";

/**
 * The boot banner: what this process is, and what is NOT connected to it.
 *
 * Every sentence comes from the message catalog (M104) — this file holds keys
 * and numbers, never prose. That rule is not decoration here: the banner's whole
 * job is to say "these numbers are seeded, no external system is attached", and
 * a hardcoded Turkish sentence in a source file is exactly the drift M104
 * exists to prevent. The same keys render on Studio's health screen, so the
 * console and the browser cannot end up telling different stories.
 */

export type Translate = (locale: Locale, key: string, params?: Record<string, string>) => string;

export interface BannerAddress {
  readonly host: string;
  readonly port: number;
}

export function bannerLines(
  t: Translate,
  summary: SeedSummary,
  address: BannerAddress,
  locale: Locale = "tr",
): readonly string[] {
  const rule = "─".repeat(74);
  return [
    rule,
    `  ${t(locale, "demo.stack.title")}`,
    `  ${t(locale, "demo.stack.note")}`,
    `  ${t(locale, "demo.stack.not_connected")}`,
    rule,
    `  ${t(locale, "demo.stack.listening", { host: address.host, port: String(address.port) })}`,
    `  ${t(locale, "demo.stack.seeded", {
      runs: String(summary.runs),
      gates: String(summary.openGates),
      journal: String(summary.journalEntries),
      audit: String(summary.auditEvents),
    })}`,
    `  ${t(locale, "demo.stack.credentials")}`,
    rule,
  ];
}
