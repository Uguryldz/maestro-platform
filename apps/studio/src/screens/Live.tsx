import { useMemo } from "react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { STEP_IDS, STEP_META, type StepId } from "@maestro/contracts";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Card, Table } from "../ui/index.ts";
import type { Column } from "../ui/index.ts";
import { QueryState } from "./shared/QueryState.tsx";
import { ageLabel } from "./shared/format.ts";
import { useRuns, type RunRow } from "./shared/runs.ts";
import { RunStatusCell } from "./Tickets.tsx";
import "./shared/screens.css";

/**
 * Screen: live — what actually happens between "ticket written" and "merged".
 *
 * The mock plays a scripted 40-second animation with invented log lines. That
 * is a sales demo, and reproducing it here would put fabricated run output on a
 * console operators use to make decisions — the exact failure mode the brief
 * calls out. Screens must not show data the system did not produce.
 *
 * So this screen keeps the mock's teaching job and drops the fiction:
 *  - the pipeline is drawn from the REAL step table (`STEP_IDS` / `STEP_META`),
 *    labelled with each step's kind, so who-does-what is visible at a glance;
 *  - the "watch it happen" half is the operator's OWN in-flight work, polled
 *    from `GET /studio/runs` — a real live view instead of a fake one.
 *
 * "In flight" now means `running` OR `gate`: the workflow vocabulary can tell
 * the two apart, and a run parked at a gate is the one most worth watching —
 * it is waiting on a person. The old Temporal-backed list called both
 * "running" and could not separate them, so the step column below was empty.
 */

/** Poll while the tab is open; there is no event stream from the BFF yet. */
export const LIVE_REFRESH_MS = 15_000;

const KIND_TONE = {
  system: "gray",
  ai: "blue",
  human_gate: "amber",
  human_wait: "orange",
  auto_gate: "teal",
} as const;

export function LiveScreen(): ReactNode {
  const t = useT();
  const navigate = useNavigate();

  const { data, isPending, error, refetch } = useRuns(50, {
    refetchInterval: LIVE_REFRESH_MS,
  });
  const running = useMemo(
    () => (data?.runs ?? []).filter((run) => run.status === "running" || run.status === "gate"),
    [data],
  );

  const columns: readonly Column<RunRow>[] = [
    {
      key: "ticket",
      header: t("col.ticket"),
      cell: (run) => (
        <>
          <b className="screen-mono">{run.ticketKey}</b>
          <div className="screen-note">{run.title}</div>
        </>
      ),
    },
    {
      key: "status",
      header: t("col.status"),
      cell: (run) => <RunStatusCell status={run.status} />,
    },
    {
      key: "step",
      header: t("col.step"),
      // The step the run is ON — the single most useful "what is happening
      // right now" fact, and the one the Temporal-backed list never carried.
      cell: (run) =>
        run.step === null ? (
          "—"
        ) : (
          <>
            <span className="screen-mono">{run.step}</span> {t(`steps.${run.step}`)}
          </>
        ),
    },
    {
      key: "age",
      header: t("col.age"),
      align: "right",
      cell: (run) => {
        const age = ageLabel(run.startedAt);
        return age === null ? "—" : t(age.key, age.params);
      },
    },
  ];

  return (
    <div className="screen-stack">
      <Card title={t("live.intro.title")} subtitle={t("live.intro.subtitle")}>
        <div className="screen-flow">
          {["write", "approve_analysis", "approve_pr", "merge"].map((phase, index) => (
            <span key={phase} className="screen-flow__item screen-flow__item--on">
              {String(index + 1)} · {t(`live.phase.${phase}`)}
            </span>
          ))}
        </div>
        <p className="screen-note">{t("live.intro.body")}</p>
      </Card>

      <Card title={t("live.pipeline.title")} subtitle={t("live.pipeline.subtitle")}>
        <div className="screen-steps">
          {STEP_IDS.map((step) => (
            <PipelineRow key={step} step={step} />
          ))}
        </div>
        <p className="screen-note">{t("live.pipeline.note")}</p>
      </Card>

      <Card
        title={t("live.running.title")}
        subtitle={t("live.running.subtitle")}
        padded={false}
        actions={
          <Link className="ui-btn ui-btn--sm" to="/tickets">
            {t("live.running.all")}
          </Link>
        }
      >
        <QueryState
          isPending={isPending}
          error={error}
          onRetry={() => void refetch()}
          skeletonRows={4}
        >
          <Table
            columns={columns}
            rows={running}
            rowKey={(run) => run.ticketKey}
            emptyLabel={t("live.running.empty")}
            caption={t("live.running.caption")}
            onRowClick={(run) => void navigate(`/detail/${run.ticketKey}`)}
          />
        </QueryState>
      </Card>
    </div>
  );
}

function PipelineRow({ step }: { readonly step: StepId }): ReactNode {
  const t = useT();
  const meta = STEP_META[step];
  return (
    <div className="screen-step">
      <span className="screen-step__num">{step}</span>
      <span className="screen-step__title">{t(meta.titleKey)}</span>
      <span className="screen-step__state">
        <Badge tone={KIND_TONE[meta.kind]}>{t(`step.kind.${meta.kind}`)}</Badge>
      </span>
    </div>
  );
}
