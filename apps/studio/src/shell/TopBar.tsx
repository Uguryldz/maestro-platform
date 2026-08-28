import type { ReactNode } from "react";
import { useAuth } from "../auth/AuthProvider.tsx";
import { useI18n, useT } from "../i18n/I18nProvider.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { KillSwitchIndicator } from "./KillSwitchIndicator.tsx";

export interface TopBarProps {
  /** Already-translated page heading for the current route. */
  readonly title: string;
}

/** Mirrors `.top` from the mock: heading, kill-switch state, user, language. */
export function TopBar({ title }: TopBarProps): ReactNode {
  const t = useT();
  const { locale, setLocale } = useI18n();
  const { session, logout } = useAuth();

  return (
    <header className="shell__top">
      <h1>{title}</h1>
      <div className="shell__spacer" />

      <KillSwitchIndicator />

      {session?.delegated === true && <Badge tone="purple">{t("shell.delegated")}</Badge>}

      <select
        className="shell__lang"
        aria-label={t("shell.language")}
        value={locale}
        onChange={(event) => setLocale(event.target.value === "en" ? "en" : "tr")}
      >
        <option value="tr">{t("locale.tr")}</option>
        <option value="en">{t("locale.en")}</option>
      </select>

      {session !== null && <span className="shell__user">{session.username}</span>}

      <Button size="sm" onClick={() => void logout()}>
        {t("shell.logout")}
      </Button>
    </header>
  );
}
