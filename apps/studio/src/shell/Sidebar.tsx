import type { ReactNode } from "react";
import { NavLink } from "react-router";
import { NAV_GROUPS, NAV_GROUP_KEY, SCREENS } from "../app/screens.ts";
import { useAuth } from "../auth/AuthProvider.tsx";
import { hasAnyRole } from "../auth/types.ts";
import { useT } from "../i18n/I18nProvider.tsx";

/**
 * Left navigation, grouped exactly as the mock's NAV table.
 *
 * Entries whose `roles` the user lacks are hidden. That is a convenience so
 * operators are not sent to screens that would only 403 — it is NOT a security
 * boundary. The BFF authorises every request on its own; see RequireSession.tsx.
 */
export function Sidebar(): ReactNode {
  const t = useT();
  const { session } = useAuth();

  return (
    <nav className="shell__side" aria-label={t("shell.nav_label")}>
      <div className="shell__brand">
        <span className="shell__logo" aria-hidden="true">
          M
        </span>
        <span>
          <b>{t("app.name")}</b>
          <small>{t("app.tagline")}</small>
        </span>
      </div>

      {NAV_GROUPS.map((group) => {
        const items = SCREENS.filter(
          (screen) =>
            screen.group === group &&
            screen.navKey !== undefined &&
            hasAnyRole(session, screen.roles ?? []),
        );
        if (items.length === 0) return null;

        return (
          <div key={group}>
            <div className="shell__navgroup">{t(NAV_GROUP_KEY[group])}</div>
            {items.map((screen) => (
              <NavLink
                key={screen.id}
                to={`/${screen.path}`}
                className={({ isActive }) =>
                  isActive ? "shell__nav shell__nav--active" : "shell__nav"
                }
              >
                <span className="shell__ic" aria-hidden="true">
                  {screen.icon}
                </span>
                {t(screen.navKey as string)}
                {screen.soon === true && (
                  <span className="shell__soon">{t("nav.soon")}</span>
                )}
              </NavLink>
            ))}
          </div>
        );
      })}
    </nav>
  );
}
