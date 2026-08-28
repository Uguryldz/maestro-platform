import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { messageKeyOf } from "../api/errors.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Input, Table, useToast } from "../ui/index.ts";
import type { Column } from "../ui/index.ts";
import { QueryState } from "./shared/QueryState.tsx";
import { useClarificationAnswer } from "./shared/signals.ts";
import { ageLabel } from "./shared/format.ts";
import { useRuns, type RunRow } from "./shared/runs.ts";
import "./shared/screens.css";

/**
 * Screen: clarify — step 2b, where intake found the ticket incomplete and is
 * waiting on the reporter.
 *
 * The wait is UNBOUNDED by design (M14): there is no auto-reject, because a
 * timed-out ticket loses the flow context that makes the answer cheap. The
 * reminder ladder (Jira 24h → Teams/mail 72h → delegation on day 7) is the
 * pressure mechanism instead.
 *
 * Answering sends the `clarificationAnswered` SIGNAL, the same channel a Jira
 * comment takes.
 *
 * The list below is now the REAL 2b queue. `GET /studio/runs` joins each
 * ticket's workflow state onto the catalog record, so `step === "2b"` is a fact
 * this screen can read directly — the old Temporal-backed `/runs` carried no
 * step at all and could only offer "every running workflow", which made the
 * operator open rows to find the one actually waiting on them.
 *
 * Picking a row still only fills the ticket field: the BFF decides whether the
 * signal is deliverable (404 `no_run` when nothing is listening), because a
 * step read a moment ago is not a promise the run is still parked there.
 */

/** Step 2b — clarification, the only step that waits on the reporter (M14). */
const CLARIFY_STEP = "2b";

export function ClarifyScreen(): ReactNode {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const answer = useClarificationAnswer();

  const [ticket, setTicket] = useState("");
  const [text, setText] = useState("");
  const [touched, setTouched] = useState(false);

  const { data, isPending, error, refetch } = useRuns(200);
  const open = useMemo(
    () => (data?.runs ?? []).filter((run) => run.step === CLARIFY_STEP),
    [data],
  );

  const ticketMissing = ticket.trim() === "";
  const textMissing = text.trim() === "";

  function submit(): void {
    setTouched(true);
    if (ticketMissing || textMissing) return;
    answer.mutate(
      { ticket: ticket.trim(), text: text.trim() },
      {
        onSuccess: () => {
          toast.show("success", t("clarify.toast.sent", { ticket: ticket.trim() }));
          setText("");
          setTouched(false);
        },
        onError: (mutationError) => toast.show("error", t(messageKeyOf(mutationError))),
      },
    );
  }

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
      key: "reporter",
      header: t("col.reporter"),
      // Who is being waited ON — the person the reminder ladder chases (M45).
      cell: (run) => run.reporter,
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
    {
      key: "pick",
      header: t("col.action"),
      align: "right",
      cell: (run) => (
        <Button size="sm" onClick={() => setTicket(run.ticketKey)}>
          {t("clarify.action.pick")}
        </Button>
      ),
    },
  ];

  return (
    <div className="screen-grid screen-grid--detail">
      <div className="screen-stack">
        <Card title={t("clarify.answer.title")} subtitle={t("clarify.answer.subtitle")}>
          <Input
            label={t("clarify.field.ticket")}
            value={ticket}
            onChange={(event) => setTicket(event.target.value)}
            hint={t("clarify.field.ticket_hint")}
            {...(touched && ticketMissing ? { error: t("error.invalid_ticket_key") } : {})}
          />
          <Input
            label={t("clarify.field.answer")}
            value={text}
            onChange={(event) => setText(event.target.value)}
            hint={t("clarify.field.answer_hint")}
            {...(touched && textMissing ? { error: t("clarify.error.answer_required") } : {})}
          />
          <div className="screen-actions">
            <Button
              variant="primary"
              busy={answer.isPending}
              disabled={ticketMissing || textMissing}
              onClick={submit}
            >
              {t("clarify.action.send")}
            </Button>
          </div>
          <p className="screen-note">{t("clarify.answer.channel")}</p>
        </Card>

        <Card title={t("clarify.open.title")} subtitle={t("clarify.open.subtitle")} padded={false}>
          <QueryState
            isPending={isPending}
            error={error}
            onRetry={() => void refetch()}
            skeletonRows={4}
          >
            <Table
              columns={columns}
              rows={open}
              rowKey={(run) => run.ticketKey}
              emptyLabel={t("clarify.open.empty")}
              caption={t("clarify.open.caption")}
              onRowClick={(run) => void navigate(`/detail/${run.ticketKey}`)}
            />
          </QueryState>
        </Card>
      </div>

      <div className="screen-stack">
        <Card title={t("clarify.loop.title")}>
          <dl className="screen-kv">
            <dt>{t("clarify.loop.step")}</dt>
            <dd>
              <Badge tone="amber">{t("steps.2b")}</Badge>
            </dd>
            <dt>{t("clarify.loop.wait")}</dt>
            <dd>{t("clarify.loop.wait_value")}</dd>
            <dt>{t("clarify.loop.reminders")}</dt>
            <dd>{t("clarify.loop.reminders_value")}</dd>
            <dt>{t("clarify.loop.after")}</dt>
            <dd>{t("clarify.loop.after_value")}</dd>
          </dl>
        </Card>

        <Card title={t("clarify.why.title")}>
          <p className="screen-note">{t("clarify.why.body")}</p>
        </Card>
      </div>
    </div>
  );
}
