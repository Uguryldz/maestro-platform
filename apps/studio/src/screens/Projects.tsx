import type { ReactNode } from "react";
import { useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import type { RoutingView } from "./common/admin-api.ts";
import { Card, TabPanel, Tabs } from "../ui/index.ts";
import { OnboardScreen } from "./Onboard.tsx";
import { RoutingScreen } from "./Routing.tsx";
import { ListeningScreen } from "./Listening.tsx";
import "./shared/screens.css";

/**
 * Screen: projects — one page for the three steps of binding a project, which
 * used to be three separate menu entries that pointed at each other.
 *
 * They are one SEQUENTIAL workflow around a single `projectKey`: you ADD an
 * application, a second admin APPROVES it into a binding, and then you add the
 * LISTENING rules that decide which tickets Maestro picks up. An admin landing
 * here could not tell that order from three equal-weight tabs, so the page now
 * makes the journey explicit:
 *
 *  - a "how it works" strip across the top shows all three steps as a numbered
 *    path (① → ② → ③), with the current one highlighted — the operator sees
 *    where they are and what comes next at a glance (the Progress-Indicators and
 *    Empty-States UX guidance);
 *  - the tabs themselves are numbered ("1 · …") so their order reads as steps,
 *    not as unrelated tools.
 *
 * The active tab lives in the URL (`?tab=`), so cross-tab jumps still work and an
 * old `/routing` deep link redirects here with its tab selected. Each tab renders
 * the ORIGINAL screen component unchanged.
 */

const TAB_IDS = ["onboard", "routing", "listening"] as const;
type TabId = (typeof TAB_IDS)[number];

function isTab(value: string | null): value is TabId {
  return value === "onboard" || value === "routing" || value === "listening";
}

export function ProjectsScreen(): ReactNode {
  const t = useT();
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab");

  // How the page opens depends on whether anything is bound yet. A fresh install
  // has no bindings, so it lands on "add an application" (step 1) — the only
  // useful thing to do. Once at least one project is bound, landing on the empty
  // add-form hides the very thing the admin came to see ("bağladığım uygulamayı
  // göremiyorum"), so the default becomes the LIST of bound projects (step 2).
  // An explicit `?tab=` in the URL always wins over this heuristic.
  const routing = useQuery({
    queryKey: ["routing"],
    queryFn: ({ signal }) => api.get<RoutingView>("/routing", { signal }),
  });
  const hasBindings = (routing.data?.projects.length ?? 0) > 0;
  const fallback: TabId = hasBindings ? "routing" : "onboard";
  const tab: TabId = isTab(raw) ? raw : fallback;
  const activeIndex = TAB_IDS.indexOf(tab);

  const select = (id: string): void => {
    const next = new URLSearchParams(params);
    next.set("tab", id);
    // A tab switch is not a project selection: drop a stale `projectKey` from the
    // previous tab so it does not leak into the one being opened by hand.
    if (id !== tab) next.delete("projectKey");
    setParams(next, { replace: false });
  };

  return (
    <div className="scr-stack">
      {/* The journey, spelled out. Three numbered steps with arrows between them;
          the current step is highlighted and each is clickable. This is the one
          thing that tells a first-time admin "do these in order, you are here". */}
      <Card title={t("projects.journey.title")} subtitle={t("projects.journey.sub")}>
        <ol className="proj-journey">
          {TAB_IDS.map((id, i) => (
            <li key={id} className="proj-journey__item">
              <button
                type="button"
                className={
                  "proj-journey__step" +
                  (i === activeIndex ? " proj-journey__step--on" : "") +
                  (i < activeIndex ? " proj-journey__step--done" : "")
                }
                onClick={() => select(id)}
              >
                <span className="proj-journey__num">{i + 1}</span>
                <span className="proj-journey__body">
                  <span className="proj-journey__label">{t(`projects.tab.${id}`)}</span>
                  <span className="proj-journey__hint">{t(`projects.journey.step.${id}`)}</span>
                </span>
              </button>
              {i < TAB_IDS.length - 1 && <span className="proj-journey__arrow">→</span>}
            </li>
          ))}
        </ol>
      </Card>

      <Tabs
        label={t("projects.tabs.label")}
        active={tab}
        onChange={select}
        items={TAB_IDS.map((id, i) => ({ id, label: `${i + 1} · ${t(`projects.tab.${id}`)}` }))}
      />

      <TabPanel id="onboard" active={tab}>
        <OnboardScreen />
      </TabPanel>
      <TabPanel id="routing" active={tab}>
        <RoutingScreen />
      </TabPanel>
      <TabPanel id="listening" active={tab}>
        <ListeningScreen />
      </TabPanel>
    </div>
  );
}
