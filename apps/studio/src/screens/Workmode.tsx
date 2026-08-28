import { useState } from "react";
import type { ReactNode } from "react";
import { WorkMode } from "@maestro/contracts";
import { messageKeyOf } from "../api/errors.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Input, Modal, Select, Table, useToast, workModeTone } from "../ui/index.ts";
import type { Column } from "../ui/index.ts";
import { useModeChange } from "./shared/signals.ts";
import "./shared/screens.css";

/**
 * Screen: workmode — the four modes, and the control that changes one mid-flow.
 *
 * The matrix is static because it IS static: `WorkMode` is a frozen contract
 * enum and who-does-what per mode is a product rule, not fetched state. The
 * only live part is the change itself, which goes out as the `modeChange`
 * signal — the same path Jira's `/mode-change` comment takes.
 *
 * Changing mode mid-flow rewrites who does the work on a ticket that may
 * already have human approvals on it, so it asks for confirmation first.
 */

const MODES = WorkMode.options;

/** Which actor performs each phase, per mode. `ai` / `human` only — no prose. */
const MATRIX: Readonly<Record<WorkMode, readonly ("ai" | "human")[]>> = {
  full_auto: ["ai", "ai", "ai", "ai", "ai"],
  ai_assist: ["ai", "human", "ai", "ai", "ai"],
  human_lead: ["ai", "human", "ai", "human", "human"],
  human_only: ["human", "human", "human", "human", "human"],
};

const PHASES = ["analysis", "code", "review", "test_design", "test_run"] as const;

interface MatrixRow {
  readonly mode: WorkMode;
}

export function WorkmodeScreen(): ReactNode {
  const t = useT();
  const toast = useToast();
  const change = useModeChange();

  const [ticket, setTicket] = useState("");
  const [mode, setMode] = useState<WorkMode>("ai_assist");
  const [confirming, setConfirming] = useState(false);
  const [touched, setTouched] = useState(false);

  const ticketMissing = ticket.trim() === "";

  function submit(): void {
    change.mutate(
      { ticket: ticket.trim(), mode },
      {
        onSuccess: (result) => {
          setConfirming(false);
          toast.show(
            "success",
            t("workmode.toast.changed", {
              ticket: ticket.trim(),
              mode: t(`mode.${result.mode}`),
            }),
          );
        },
        onError: (error) => toast.show("error", t(messageKeyOf(error))),
      },
    );
  }

  const columns: readonly Column<MatrixRow>[] = [
    {
      key: "mode",
      header: t("col.mode"),
      cell: (row) => <Badge tone={workModeTone(row.mode)}>{t(`mode.${row.mode}`)}</Badge>,
    },
    ...PHASES.map((phase, index) => ({
      key: phase,
      header: t(`workmode.phase.${phase}`),
      cell: (row: MatrixRow) => {
        const actor = MATRIX[row.mode][index] ?? "ai";
        return (
          <Badge tone={actor === "ai" ? "blue" : "orange"}>{t(`workmode.actor.${actor}`)}</Badge>
        );
      },
    })),
    {
      key: "use",
      header: t("workmode.col.use"),
      cell: (row) => <span className="screen-note">{t(`workmode.use.${row.mode}`)}</span>,
    },
  ];

  return (
    <div className="screen-stack">
      <Card title={t("workmode.matrix.title")} subtitle={t("workmode.matrix.subtitle")} padded={false}>
        <Table
          columns={columns}
          rows={MODES.map((value) => ({ mode: value }))}
          rowKey={(row) => row.mode}
          emptyLabel={t("empty.no_data")}
          caption={t("workmode.matrix.caption")}
        />
      </Card>

      <div className="screen-grid screen-grid--2">
        <Card title={t("workmode.change.title")} subtitle={t("workmode.change.subtitle")}>
          <Input
            label={t("workmode.field.ticket")}
            value={ticket}
            onChange={(event) => setTicket(event.target.value)}
            hint={t("workmode.field.ticket_hint")}
            {...(touched && ticketMissing ? { error: t("error.invalid_ticket_key") } : {})}
          />
          <Select
            label={t("workmode.field.mode")}
            value={mode}
            onChange={(event) => setMode(event.target.value as WorkMode)}
            options={MODES.map((value) => ({ value, label: t(`mode.${value}`) }))}
          />
          <div className="screen-actions">
            <Button
              variant="primary"
              disabled={ticketMissing}
              onClick={() => {
                setTouched(true);
                if (!ticketMissing) setConfirming(true);
              }}
            >
              {t("workmode.action.change")}
            </Button>
          </div>
          <p className="screen-note">{t("workmode.change.note")}</p>
        </Card>

        <Card title={t("workmode.handover.title")}>
          <dl className="screen-kv">
            <dt className="screen-mono">/ai-takeover</dt>
            <dd>{t("workmode.handover.takeover")}</dd>
            <dt className="screen-mono">/ai-handoff</dt>
            <dd>{t("workmode.handover.handoff")}</dd>
            <dt className="screen-mono">/mode-change</dt>
            <dd>{t("workmode.handover.mode_change")}</dd>
          </dl>
          <p className="screen-note">{t("workmode.handover.note")}</p>
        </Card>
      </div>

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t("workmode.confirm.title", { ticket: ticket.trim() })}
        closeLabel={t("action.close")}
        footer={
          <>
            <Button onClick={() => setConfirming(false)}>{t("action.cancel")}</Button>
            <Button variant="primary" busy={change.isPending} onClick={submit}>
              {t("workmode.confirm.submit")}
            </Button>
          </>
        }
      >
        <p>{t("workmode.confirm.body", { mode: t(`mode.${mode}`) })}</p>
        <p className="screen-note">{t("workmode.confirm.note")}</p>
      </Modal>
    </div>
  );
}
