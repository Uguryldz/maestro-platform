import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  DEFAULT_LOCALE,
  type Locale,
  type MessageParams,
  readStoredLocale,
  translate,
  writeStoredLocale,
} from "./catalog.ts";

export interface I18nValue {
  readonly locale: Locale;
  readonly setLocale: (next: Locale) => void;
  /** Throws MissingMessageError when the key is absent — no silent fallback. */
  readonly t: (key: string, params?: MessageParams) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export interface I18nProviderProps {
  readonly children: ReactNode;
  /** Tests inject a fixed locale; the app reads localStorage. */
  readonly initialLocale?: Locale;
  readonly storage?: Storage | undefined;
}

export function I18nProvider({
  children,
  initialLocale,
  storage,
}: I18nProviderProps): ReactNode {
  const resolvedStorage =
    storage ?? (typeof window === "undefined" ? undefined : window.localStorage);

  const [locale, setLocaleState] = useState<Locale>(
    () => initialLocale ?? readStoredLocale(resolvedStorage),
  );

  const setLocale = useCallback(
    (next: Locale) => {
      setLocaleState(next);
      writeStoredLocale(resolvedStorage, next);
      if (typeof document !== "undefined") document.documentElement.lang = next;
    },
    [resolvedStorage],
  );

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      setLocale,
      t: (key, params) => translate(locale, key, params ?? {}),
    }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (ctx === null) {
    throw new Error("useI18n must be used inside <I18nProvider>");
  }
  return ctx;
}

/** Shorthand for the common case: `const t = useT(); t("nav.dash")`. */
export function useT(): I18nValue["t"] {
  return useI18n().t;
}

export { DEFAULT_LOCALE };
