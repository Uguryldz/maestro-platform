import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { LOGIN_SCREEN, NAV_GROUP_KEY, NAV_GROUPS, SCREENS } from "../src/app/screens.ts";
import { knownErrorCodes, errorMessageKey } from "../src/api/errors.ts";
import { ErrorBoundary } from "../src/app/ErrorBoundary.tsx";
import { I18nProvider, useT } from "../src/i18n/I18nProvider.tsx";
import { LOCALES, MissingMessageError, translate } from "../src/i18n/catalog.ts";

describe("i18n catalog", () => {
  it("has every route table key in both locales", () => {
    for (const locale of LOCALES) {
      for (const screen of [...SCREENS, LOGIN_SCREEN]) {
        expect(() => translate(locale, screen.titleKey), `${screen.titleKey} @ ${locale}`).not.toThrow();
        if (screen.navKey !== undefined) {
          expect(() => translate(locale, screen.navKey as string)).not.toThrow();
        }
      }
      for (const group of NAV_GROUPS) {
        expect(() => translate(locale, NAV_GROUP_KEY[group])).not.toThrow();
      }
    }
  });

  it("has a message for every BFF error code, in both locales", () => {
    for (const locale of LOCALES) {
      for (const code of knownErrorCodes()) {
        expect(() => translate(locale, errorMessageKey(code)), `${code} @ ${locale}`).not.toThrow();
      }
      // The catch-all used for codes we do not know must also exist.
      expect(() => translate(locale, "error.unexpected")).not.toThrow();
    }
  });

  it("has the shell chrome keys in both locales", () => {
    const keys = ["app.name", "app.tagline", "shell.language", "shell.logout", "locale.tr", "locale.en"];
    for (const locale of LOCALES) {
      for (const key of keys) expect(() => translate(locale, key)).not.toThrow();
    }
  });

  it("throws on a missing key rather than falling back silently", () => {
    expect(() => translate("tr", "no.such.key.at.all")).toThrow(MissingMessageError);
    expect(() => translate("en", "no.such.key.at.all")).toThrow(MissingMessageError);
  });

  it("interpolates params", () => {
    expect(translate("en", "screen.placeholder.description", { screen: "dash" })).toContain("dash");
  });
});

function Boom(): ReactNode {
  const t = useT();
  return <span>{t("definitely.not.a.key")}</span>;
}

describe("missing key at render time", () => {
  it("surfaces a visible error instead of a blank or half-translated screen", () => {
    // React logs the caught error; silence it so the run stays readable.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <I18nProvider initialLocale="tr">
          <Boom />
        </I18nProvider>
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("MissingMessageError");
    spy.mockRestore();
  });
});
