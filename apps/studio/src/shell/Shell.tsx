import type { ReactNode } from "react";
import { Outlet, useLocation } from "react-router";
import { SCREENS } from "../app/screens.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { TopBar } from "./TopBar.tsx";
import "./Shell.css";

/**
 * The application chrome: sidebar + top bar + content well. Every authenticated
 * route renders inside this Outlet, so screens supply only their own body.
 */
export function Shell(): ReactNode {
  const t = useT();
  const location = useLocation();

  // Longest matching path wins, so /detail/:ticket beats a bare prefix.
  const current = [...SCREENS]
    .filter((screen) => {
      const base = `/${screen.path.split("/:")[0] ?? screen.path}`;
      return location.pathname === base || location.pathname.startsWith(`${base}/`);
    })
    .sort((a, b) => b.path.length - a.path.length)[0];

  const title = current === undefined ? t("app.name") : t(current.titleKey);

  return (
    <div className="shell">
      <Sidebar />
      <div className="shell__main">
        <TopBar title={title} />
        <main className="shell__content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
