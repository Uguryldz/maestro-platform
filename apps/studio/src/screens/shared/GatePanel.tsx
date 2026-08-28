import { useState } from "react";
import type { ReactNode } from "react";
import { type StepId } from "@maestro/contracts";
import { messageKeyOf } from "../../api/errors.ts";
import { useAuth } from "../../auth/AuthProvider.tsx";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Input, Modal, useToast } from "../../ui/index.ts";
import { mayDecide, useGateDecision } from "./signals.ts";

export interface GatePanelProps {
  readonly ticket: string;
  readonly step: StepId;
}

/**
 * The approve / reject pair for an open human gate.
 *
 * Both buttons open a confirmation modal first: a signed gate decision is
 * irreversible (it goes into the hash-chained audit trail and moves the flow),
 * which is exactly the class of action that must not be one stray click away.
 * Reject additionally requires a reason — the text is handed to the agent to
 * fix in the SAME session, so an empty rejection destroys the only useful part
 * of the message.
 */
export function GatePanel({ ticket, step }: GatePanelProps): ReactNode {
  const t = useT();
  const toast = useToast();
  const { session } = useAuth();
  const decide = useGateDecision();

  const [confirming, setConfirming] = useState<"approve" | "reject" | null>(null);
  const [reason, setReason] = useState("");
  const [reasonTouched, setReasonTouched] = useState(false);

  // Greyed out, not hidden: the operator should see the gate exists and learn
  // that it is not theirs. This is a usability signal ONLY — the BFF verifies
  // group membership on every decision and refuses a delegated (AI) token.
  const allowed = mayDecide(session, step);
  const reasonMissing = reason.trim() === "";

  function close(): void {
    setConfirming(null);
    setReason("");
    setReasonTouched(false);
  }

  function submit(decision: "approve" | "reject"): void {
    if (decision === "reject" && reasonMissing) {
      setReasonTouched(true);
      return;
    }
    decide.mutate(
      { ticket, decision, ...(decision === "reject" ? { reason: reason.trim() } : {}) },
      {
        onSuccess: () => {
          close();
          toast.show(
            "success",
            t(decision === "approve" ? "gate.toast.approved" : "gate.toast.rejected", { ticket }),
          );
        },
        onError: (error) => toast.show("error", t(messageKeyOf(error))),
      },
    );
  }

  return (
    <Card title={t("gate.waiting.title")} subtitle={t("gate.waiting.subtitle")}>
      <dl className="screen-kv">
        <dt>{t("gate.field.gate")}</dt>
        <dd>
          <Badge tone="amber">{t(`steps.${step}`)}</Badge>
        </dd>
        <dt>{t("gate.field.channel")}</dt>
        <dd>{t("gate.field.channel_value")}</dd>
        <dt>{t("gate.field.reminders")}</dt>
        <dd>{t("gate.field.reminders_value")}</dd>
      </dl>

      <div className="screen-actions">
        <Button
          variant="success"
          disabled={!allowed}
          onClick={() => setConfirming("approve")}
        >
          {t("gate.action.approve")}
        </Button>
        <Button variant="danger" disabled={!allowed} onClick={() => setConfirming("reject")}>
          {t("gate.action.reject")}
        </Button>
      </div>
      {!allowed && <p className="screen-note">{t("gate.not_owner")}</p>}
      <p className="screen-note">{t("gate.jira_hint")}</p>

      <Modal
        open={confirming === "approve"}
        onClose={close}
        title={t("gate.confirm.approve_title", { ticket })}
        closeLabel={t("action.close")}
        footer={
          <>
            <Button onClick={close}>{t("action.cancel")}</Button>
            <Button variant="success" busy={decide.isPending} onClick={() => submit("approve")}>
              {t("gate.confirm.approve_submit")}
            </Button>
          </>
        }
      >
        <p>{t("gate.confirm.approve_body")}</p>
        <p className="screen-note">{t("gate.confirm.irreversible")}</p>
      </Modal>

      <Modal
        open={confirming === "reject"}
        onClose={close}
        title={t("gate.confirm.reject_title", { ticket })}
        closeLabel={t("action.close")}
        footer={
          <>
            <Button onClick={close}>{t("action.cancel")}</Button>
            <Button
              variant="danger"
              busy={decide.isPending}
              disabled={reasonMissing}
              onClick={() => submit("reject")}
            >
              {t("gate.confirm.reject_submit")}
            </Button>
          </>
        }
      >
        <p>{t("gate.confirm.reject_body")}</p>
        <Input
          label={t("gate.field.reason")}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          onBlur={() => setReasonTouched(true)}
          hint={t("gate.field.reason_hint")}
          {...(reasonTouched && reasonMissing
            ? { error: t("error.reject_needs_reason") }
            : {})}
        />
      </Modal>
    </Card>
  );
}
