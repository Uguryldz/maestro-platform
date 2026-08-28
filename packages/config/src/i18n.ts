import { Locale } from "@maestro/contracts";
import tr from "../locales/tr.json" with { type: "json" };
import en from "../locales/en.json" with { type: "json" };

/**
 * Message catalog (M104). ALL user-facing text lives here — packages must
 * reference message keys, never hardcode strings. Adding a locale =
 * adding a catalog file + one entry in the Locale enum.
 */
type Catalog = Record<string, string>;

const CATALOGS: Record<Locale, Catalog> = {
  tr: tr as Catalog,
  en: en as Catalog,
};

export const DEFAULT_LOCALE: Locale = "tr";

export function catalogKeys(locale: Locale): string[] {
  return Object.keys(CATALOGS[locale]).sort();
}

export class MissingMessageError extends Error {
  constructor(locale: Locale, key: string) {
    super(`missing message "${key}" for locale "${locale}"`);
    this.name = "MissingMessageError";
  }
}

/**
 * Translate a key with {param} interpolation. Missing key is an error,
 * not a silent fallback — catalog parity is enforced by tests.
 */
export function t(locale: Locale, key: string, params: Record<string, string> = {}): string {
  const template = CATALOGS[locale][key];
  if (template === undefined) throw new MissingMessageError(locale, key);
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => params[name] ?? whole);
}
