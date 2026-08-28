import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Kpi, riskTone } from "../ui/index.ts";
import { QueryState } from "./shared/QueryState.tsx";
import { ageLabel } from "./shared/format.ts";
import { useRuns, type RunRow } from "./shared/runs.ts";
import { RunStatusCell, TicketsList } from "./Tickets.tsx";
import {
  GUIDE_DISMISSED_KEY,
  readFlag,
  useSetupState,
  webhookAcked,
  writeFlag,
} from "./dash/setup-state.ts";
import "./shared/screens.css";

/**
 * Screen: dash — the operator's landing page.
 *
 * Every number on it is counted from `GET /studio/runs`, which joins the
 * platform catalog to the live workflow state. That is what makes the KPIs
 * mean what their labels say: "kapıda" counts runs whose workflow status IS
 * `gate`, not runs Temporal happens to call `running`. The mock also shows
 * runner pool capacity and a 24-hour activity feed; both need endpoints that do
 * not exist (`/runners`, `/activity`), so they are requested in the report
 * rather than filled with plausible-looking constants. A dashboard that invents
 * its own figures is worse than one that admits it has none.
 */

const ATTENTION_LIMIT = 5;

/** Statuses that mean a human has to look: a failure, or a handover (M96). */
function needsHuman(run: RunRow): boolean {
  return run.status === "fail" || run.status === "handover";
}

export function DashScreen(): ReactNode {
  const t = useT();
  const navigate = useNavigate();
  /**
   * The four KPI tiles are counted from THIS response, and `TicketsList` below
   * fetches the same endpoint with the same default scope — so both see the
   * same set and the tiles cannot claim a number the list does not show.
   *
   * That agreement is the whole reason the archive filter lives on the server
   * (0019). Hiding archived runs by filtering in `TicketsList` alone would have
   * left these tiles counting twelve failures over a list showing none, which
   * is a worse dashboard than the one that started this: a wrong number an
   * operator cannot reconcile against anything.
   *
   * No `archived` argument, deliberately: the BFF's default IS "active", and
   * spelling it out here would create a second place to keep that decision.
   */
  const { data, isPending, error, refetch } = useRuns(200);

  /**
   * There is ONE engine to report on now, and `useRuns` above already reads it.
   *
   * This screen used to open with a second, parallel account of the platform's
   * health: a poll of the pilot's `/studio/pilot/state` behind three banner
   * tones, and a "live jobs" card built from the pilot's own run history. The
   * pilot is retired, so all of it could only ever render the absent-engine
   * case — a standing warning about a component this installation no longer
   * has, above numbers that were already telling the truth. The run list below
   * IS the live picture: `/studio/runs` joins the catalog to the workflow
   * state, and a failed read of it surfaces through `QueryState` as itself.
   */
  const runs = useMemo(() => data?.runs ?? [], [data]);

  const stats = useMemo(() => {
    const open = runs.filter((run) => run.status === "running");
    const gate = runs.filter((run) => run.status === "gate");
    const done = runs.filter((run) => run.status === "done");
    const broken = runs.filter(needsHuman);
    return { open, gate, done, broken };
  }, [runs]);

  /**
   * "Needs attention" is derived, not guessed. The order is the order a human
   * should work the queue in: broken first (a failure blocks everything behind
   * it), then runs parked at a gate (a decision only a person can make), each
   * group oldest-first. Gates are visible here for the first time — the old
   * `/runs` could not tell a gate from any other running execution, so this
   * list could only ever offer "oldest running".
   */
  const attention = useMemo(() => {
    const byAgeAsc = (a: RunRow, b: RunRow) => Date.parse(a.startedAt) - Date.parse(b.startedAt);
    return [...stats.broken.sort(byAgeAsc), ...stats.gate.sort(byAgeAsc)].slice(0, ATTENTION_LIMIT);
  }, [stats]);

  /**
   * Whether the platform's setup is still open — the ONE setup fact the Panel
   * keeps now that the checklist itself has moved into the wizard.
   *
   * The measurement is unchanged and deliberately shared: `useSetupState` is
   * the same hook the wizard's guide reads, so the Panel's note and the guide's
   * ticks can never disagree about what is finished. The webhook flag is read
   * once here rather than owned — the Panel no longer has the checkbox that
   * flips it, so there is nothing to keep in state.
   */
  const [dismissed, setDismissed] = useState(() => readFlag(GUIDE_DISMISSED_KEY));
  const setup = useSetupState(webhookAcked());
  const setupIncomplete = !setup.loading && !setup.complete;

  return (
    <div className="screen-stack">
      {/* Setup is not this screen's job any more — the Panel is a REPORT.
          The five-step checklist now lives where the work happens, in the
          wizard, and what stays here is the one line that says the platform is
          not finished plus the way to get there. A dashboard that opens with a
          tutorial is a dashboard that buries its own numbers.
          The dismissal is still honoured, and still cannot become a completion
          claim: hiding the LINE is a display preference; `setupIncomplete` is
          measured (`useSetupState`) and does not care what was dismissed. */}
      {setupIncomplete && !dismissed && (
        <div className="dash-setup-note" role="note">
          <span>{t("dash.start.incomplete_note")}</span>
          <Link className="ui-btn ui-btn--sm" to="/setup">
            {t("dash.start.open_wizard")}
          </Link>
          <Button
            variant="default"
            size="sm"
            onClick={() => {
              writeFlag(GUIDE_DISMISSED_KEY, true);
              setDismissed(true);
            }}
          >
            {t("dash.start.dismiss")}
          </Button>
        </div>
      )}

      {/* Hidden but not finished: one honest line, and the way back. Without
          this, "gizle" would quietly become "tamamlandı". */}
      {setupIncomplete && dismissed && (
        <div className="dash-setup-note" role="note">
          <span>{t("dash.start.hidden_note")}</span>
          <Button
            variant="default"
            size="sm"
            onClick={() => {
              writeFlag(GUIDE_DISMISSED_KEY, false);
              setDismissed(false);
            }}
          >
            {t("dash.start.show_again")}
          </Button>
        </div>
      )}

      <QueryState
        isPending={isPending}
        error={error}
        onRetry={() => void refetch()}
        skeletonRows={6}
        isEmpty={runs.length === 0}
        emptyTitle={t("dash.empty.title")}
        emptyDescription={t("dash.empty.description")}
      >
        <div className="screen-grid screen-grid--4">
          <Kpi
            label={t("dash.kpi.active")}
            value={String(stats.open.length)}
            note={t("dash.kpi.active_note", { n: String(stats.broken.length) })}
          />
          <Kpi
            label={t("dash.kpi.gate")}
            value={String(stats.gate.length)}
            note={t("dash.kpi.gate_note")}
          />
          <Kpi
            label={t("dash.kpi.done")}
            value={String(stats.done.length)}
            note={t("dash.kpi.done_note")}
          />
          <Kpi
            label={t("dash.kpi.total")}
            value={String(runs.length)}
            note={t("dash.kpi.total_note")}
          />
        </div>

        <Card
          title={t("dash.attention.title")}
          subtitle={t("dash.attention.subtitle")}
        >
          {attention.length === 0 ? (
            <p className="screen-note">{t("dash.attention.empty")}</p>
          ) : (
            attention.map((run) => {
              const age = ageLabel(run.startedAt);
              const broken = needsHuman(run);
              return (
                <button
                  key={run.ticketKey}
                  type="button"
                  className={broken ? "screen-issue screen-issue--alert" : "screen-issue"}
                  onClick={() => void navigate(`/detail/${run.ticketKey}`)}
                >
                  <span aria-hidden="true">{broken ? "✕" : "⏳"}</span>
                  <span className="screen-issue__body">
                    <b className="screen-mono">{run.ticketKey}</b> <RunStatusCell status={run.status} />{" "}
                    <Badge tone={riskTone(run.risk)}>{t(`risk.${run.risk}`)}</Badge>
                    <span className="screen-note">
                      {run.title}
                      {run.step === null ? "" : ` · ${t(`steps.${run.step}`)}`}
                      {age === null
                        ? ""
                        : ` · ${t("dash.attention.age", { age: t(age.key, age.params) })}`}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </Card>

        {/* The full, filterable run list over /studio/runs. Labelled honestly:
            on a live install this is the DB catalog (seed/archive records) —
            the engine's real jobs are the section at the top. */}
        <div>
          <h2 className="dash-section">{t("dash.all.title")}</h2>
          <p className="screen-note">{t("dash.all.note")}</p>
          <TicketsList />
        </div>
      </QueryState>
    </div>
  );
}
