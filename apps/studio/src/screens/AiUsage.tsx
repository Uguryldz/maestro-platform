import type { ReactNode } from "react";
import { useSearchParams } from "react-router";
import { useT } from "../i18n/I18nProvider.tsx";
import { TabPanel, Tabs } from "../ui/index.ts";
import { CostScreen } from "./Cost.tsx";
import { LlmScreen } from "./Llm.tsx";
import "./shared/screens.css";

/**
 * Screen: AI usage & cost (/cost) — one page with two views of the SAME two
 * endpoints (`/studio/cost` + `/studio/quota`).
 *
 * "Maliyet & kota" and "LLM Gateway" used to be two menu rows reading the exact
 * same data: one framed it as money/quota, the other as the AI traffic gateway.
 * They are now two tabs of one page — "Maliyet" (what it costs) and "Trafik"
 * (the pool + recent calls). The old /llm path redirects here with the traffic
 * tab selected.
 */

const VIEWS = ["cost", "traffic"] as const;
type ViewId = (typeof VIEWS)[number];

function isView(v: string | null): v is ViewId {
  return v === "cost" || v === "traffic";
}

export function AiUsageScreen(): ReactNode {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const view: ViewId = isView(params.get("view")) ? (params.get("view") as ViewId) : "cost";

  const select = (id: string): void => {
    const next = new URLSearchParams(params);
    next.set("view", id);
    setParams(next, { replace: false });
  };

  return (
    <div className="scr-stack">
      <Tabs
        label={t("aiusage.tabs.label")}
        active={view}
        onChange={select}
        items={VIEWS.map((id) => ({ id, label: t(`aiusage.tab.${id}`) }))}
      />
      <TabPanel id="cost" active={view}>
        <CostScreen />
      </TabPanel>
      <TabPanel id="traffic" active={view}>
        <LlmScreen />
      </TabPanel>
    </div>
  );
}
