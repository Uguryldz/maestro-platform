import { useState } from "react";
import type { ReactNode } from "react";
import { useParams } from "react-router";
import { useT } from "../i18n/I18nProvider.tsx";
import { Card, TabPanel, Tabs } from "../ui/index.ts";
import { JournalTab } from "./detail/JournalTab.tsx";
import { RunSidebar } from "./detail/RunSidebar.tsx";
import { StepList } from "./detail/StepList.tsx";
import { NotAvailable, QueryState } from "./shared/QueryState.tsx";
import { useRunDetail } from "./shared/runs.ts";
import "./shared/screens.css";

/**
 * Screen: detail/:ticket — one workflow, in full.
 *
 * Route param, not module state: the mock keeps the selected ticket in a global
 * (`DKEY`), which makes the view unlinkable. Here the URL is the state, so a
 * gate reminder can point straight at the run that needs a decision.
 *
 * `GET /studio/runs/:ticket` answers 404 `no_run` for a ticket Maestro never
 * ran and 403 `project_access` for one the caller may not see — both surface
 * through QueryState as translated sentences, never as a raw code.
 *
 * It returns THREE things where the old `/runs/:ticket` returned one: the
 * catalog record, the live workflow state, and the application the ticket was
 * matched to. The state may be `null` for a ticket that exists but whose
 * workflow has not started — a case the old endpoint could only express as a
 * 404, i.e. as "no such ticket", which is a different and wrong sentence. So
 * the step list is rendered only when there is a state to render, and the
 * sidebar shows the record either way.
 */

const TAB_IDS = ["steps", "journal", "analysis", "diff", "tests", "cost"] as const;
type TabId = (typeof TAB_IDS)[number];

export function DetailScreen(): ReactNode {
  const t = useT();
  const { ticket } = useParams<{ ticket: string }>();
  const [tab, setTab] = useState<TabId>("steps");

  const { data: detail, isPending, error, refetch } = useRunDetail(ticket);

  if (ticket === undefined || ticket === "") {
    return <NotAvailable detailKey="detail.no_ticket" />;
  }

  return (
    <QueryState isPending={isPending} error={error} onRetry={() => void refetch()} skeletonRows={8}>
      {detail === undefined ? null : (
        <div className="screen-grid screen-grid--detail">
          <Card padded={false}>
            <Tabs
              label={t("detail.tabs.label")}
              active={tab}
              onChange={(id) => setTab(id as TabId)}
              items={TAB_IDS.map((id) => ({ id, label: t(`detail.tab.${id}`) }))}
            />
            <div style={{ padding: 14 }}>
              <TabPanel id="steps" active={tab}>
                {/* No state means no position in the flow; marking step 0 as
                    "now" would claim the run had started. */}
                {detail.state === null ? (
                  <NotAvailable detailKey="detail.steps.not_started" />
                ) : (
                  <StepList run={detail.state} />
                )}
              </TabPanel>
              <TabPanel id="journal" active={tab}>
                <JournalTab ticket={ticket} />
              </TabPanel>
              <TabPanel id="analysis" active={tab}>
                <NotAvailable detailKey="detail.analysis.unavailable" />
              </TabPanel>
              <TabPanel id="diff" active={tab}>
                <NotAvailable detailKey="detail.diff.unavailable" />
              </TabPanel>
              <TabPanel id="tests" active={tab}>
                <NotAvailable detailKey="detail.tests.unavailable" />
              </TabPanel>
              <TabPanel id="cost" active={tab}>
                <NotAvailable detailKey="detail.cost.unavailable" />
              </TabPanel>
            </div>
          </Card>

          <RunSidebar record={detail.run} state={detail.state} application={detail.application} />
        </div>
      )}
    </QueryState>
  );
}
