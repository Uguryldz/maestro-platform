import type { ReactNode } from "react";
import { Link } from "react-router";
import { GATES_BY_RISK, type ApplicationRecord, type WorkflowRunState } from "@maestro/contracts";
import { useI18n, useT } from "../../i18n/I18nProvider.tsx";
import { Badge, Card, riskTone, workModeTone } from "../../ui/index.ts";
import { useEnumLabel } from "../common/label.ts";
import { GatePanel } from "../shared/GatePanel.tsx";
import { isApprovalGate, isClarificationWait } from "../shared/gate-utils.ts";
import { ageLabel, dateTimeLabel } from "../shared/format.ts";
import { RunStatusCell } from "../Tickets.tsx";
import { projectKeyOf, type RunDetail } from "../shared/runs.ts";

/**
 * The right-hand column of the detail screen: the open gate (if any), then the
 * run's identifying facts.
 *
 * The mock's sidebar always wanted the ADO PR, the work mode, the token spend
 * and the people involved. `WorkflowRunState` carries none of those, so this
 * panel used to show six fields and a note admitting the rest were unavailable.
 * `GET /studio/runs/:ticket` returns the platform catalog record and the
 * matched application alongside the workflow state, so those fields are now
 * READ rather than requested — and the note is gone because the gap is closed.
 *
 * Every value below still comes from a field the BFF actually sent. `null`
 * renders as an em dash: an unassigned ticket, an unmatched application and a
 * run with no PR yet are all real states, and filling them in would be the one
 * failure this project treats as worse than a blank.
 */
export interface RunSidebarProps {
  readonly record: RunDetail["run"];
  /** `null` when the ticket exists but its workflow has not started. */
  readonly state: WorkflowRunState | null;
  readonly application: ApplicationRecord | null;
}

export function RunSidebar({ record, state, application }: RunSidebarProps): ReactNode {
  const t = useT();
  const { locale } = useI18n();
  const enumLabel = useEnumLabel();
  const age = ageLabel(state?.startedAt ?? record.startedAt);

  // Risk drives how many gates the run must pass (M51). The workflow's own
  // tier wins when it has one; the catalog always carries a tier.
  const risk = state?.risk ?? record.risk;
  const gateCount = GATES_BY_RISK[risk].length;

  return (
    <div className="screen-stack">
      {state !== null && isApprovalGate(state) && (
        <GatePanel ticket={record.ticketKey} step={state.step} />
      )}

      {state !== null && isClarificationWait(state) && (
        <Card title={t("detail.clarify.title")}>
          <p className="screen-note">{t("detail.clarify.body")}</p>
          <div className="screen-actions">
            <Link className="ui-btn ui-btn--sm" to="/clarify">
              {t("detail.clarify.action")}
            </Link>
          </div>
        </Card>
      )}

      <Card title={t("detail.facts.title")}>
        <dl className="screen-kv">
          <dt>{t("detail.field.ticket")}</dt>
          <dd className="screen-mono">{record.ticketKey}</dd>

          <dt>{t("detail.field.title")}</dt>
          <dd>{record.title}</dd>

          <dt>{t("detail.field.project")}</dt>
          <dd>{projectKeyOf(record.ticketKey)}</dd>

          <dt>{t("detail.field.status")}</dt>
          <dd>
            <RunStatusCell status={state?.status ?? null} />
          </dd>

          <dt>{t("detail.field.step")}</dt>
          <dd>
            {state === null ? (
              "—"
            ) : (
              <>
                <span className="screen-mono">{state.step}</span> {t(`steps.${state.step}`)}
              </>
            )}
          </dd>

          <dt>{t("detail.field.risk")}</dt>
          <dd>
            <Badge tone={riskTone(risk)}>{t(`risk.${risk}`)}</Badge>{" "}
            <span className="screen-note">
              {t("detail.field.gates", { n: String(gateCount) })}
            </span>
          </dd>

          <dt>{t("detail.field.mode")}</dt>
          <dd>
            <Badge tone={workModeTone(record.mode)}>{enumLabel("mode", record.mode).text}</Badge>
          </dd>

          <dt>{t("detail.field.data_class")}</dt>
          <dd>
            <Badge tone={record.dataClass === "gizli" ? "red" : "gray"}>
              {enumLabel("data_class", record.dataClass).text}
            </Badge>
          </dd>

          <dt>{t("detail.field.app")}</dt>
          {/* The matched application (M100); the repo is rendered the way ADO
              addresses it, from the record's own fields. */}
          <dd>
            {application === null ? (
              "—"
            ) : (
              <>
                {application.displayName}
                <div className="screen-note screen-mono">
                  {application.adoProject}/_git/{application.adoRepo}
                </div>
              </>
            )}
          </dd>

          <dt>{t("detail.field.reporter")}</dt>
          <dd>{record.reporter}</dd>

          <dt>{t("detail.field.assignee")}</dt>
          <dd>{record.assignee ?? "—"}</dd>

          <dt>{t("detail.field.pr")}</dt>
          <dd className="screen-mono">{record.prId === null ? "—" : `#${record.prId}`}</dd>

          <dt>{t("detail.field.cost")}</dt>
          {/* Spend so far (M16). Shown to 2dp with the token split beside it —
              a cost figure without its token count cannot be sanity-checked. */}
          <dd>
            {record.costUsd.toFixed(2)} USD
            <div className="screen-note">
              {t("detail.field.tokens", {
                in: String(record.tokensIn),
                out: String(record.tokensOut),
              })}
            </div>
          </dd>

          {state !== null && (
            <>
              <dt>{t("detail.field.run_id")}</dt>
              <dd className="screen-mono">{state.runId}</dd>
            </>
          )}

          <dt>{t("detail.field.started")}</dt>
          <dd>
            {dateTimeLabel(state?.startedAt ?? record.startedAt, locale)}
            {age !== null && <span className="screen-note"> {t(age.key, age.params)}</span>}
          </dd>

          <dt>{t("detail.field.updated")}</dt>
          <dd>{dateTimeLabel(state?.updatedAt ?? record.updatedAt, locale)}</dd>
        </dl>
      </Card>

      {(record.parentTicketKey !== null || record.childTicketKeys.length > 0) && (
        <Card title={t("detail.fanout.title")}>
          <dl className="screen-kv">
            {record.parentTicketKey !== null && (
              <>
                <dt>{t("detail.fanout.parent")}</dt>
                <dd>
                  <Link className="screen-mono" to={`/detail/${record.parentTicketKey}`}>
                    {record.parentTicketKey}
                  </Link>
                </dd>
              </>
            )}
            {record.childTicketKeys.length > 0 && (
              <>
                <dt>{t("detail.fanout.children")}</dt>
                <dd>
                  {record.childTicketKeys.map((child) => (
                    <div key={child}>
                      <Link className="screen-mono" to={`/detail/${child}`}>
                        {child}
                      </Link>
                    </div>
                  ))}
                </dd>
              </>
            )}
          </dl>
        </Card>
      )}
    </div>
  );
}
