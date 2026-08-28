import { DEFAULT_LOCALE, MissingMessageError, catalogKeys, t } from "@maestro/config/i18n";
import type { Locale } from "@maestro/contracts";

/**
 * The Studio never ships its own strings. Every user-visible sentence comes
 * from packages/config/locales/{tr,en}.json (M104) through this module, which
 * is a thin re-export of the package helper plus browser concerns (persisted
 * locale choice). We deliberately do NOT copy the catalog into apps/studio.
 */
export { DEFAULT_LOCALE, MissingMessageError, catalogKeys };
export type { Locale };

export type MessageParams = Record<string, string>;

export const LOCALES: readonly Locale[] = ["tr", "en"];

const STORAGE_KEY = "maestro.locale";

export function isLocale(value: unknown): value is Locale {
  return value === "tr" || value === "en";
}

/**
 * Missing keys throw (MissingMessageError from @maestro/config) — there is no
 * silent fallback to the key name and no fallback to the other locale. A screen
 * that references a key nobody wrote must fail loudly in review, not ship a
 * half-English UI to a bank operator. The error boundary in
 * src/i18n/I18nProvider.tsx turns the throw into a visible red panel.
 */
export function translate(locale: Locale, key: string, params: MessageParams = {}): string {
  return t(locale, key, params);
}

export function readStoredLocale(storage: Pick<Storage, "getItem"> | undefined): Locale {
  const raw = storage?.getItem(STORAGE_KEY);
  return isLocale(raw) ? raw : DEFAULT_LOCALE;
}

export function writeStoredLocale(
  storage: Pick<Storage, "setItem"> | undefined,
  locale: Locale,
): void {
  storage?.setItem(STORAGE_KEY, locale);
}
