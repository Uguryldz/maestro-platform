import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Button, Input, Modal } from "../../ui/index.ts";

export interface ConfirmModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Called with the typed reason once it is non-empty. */
  readonly onConfirm: (reason: string) => void;
  /** Already-translated dialog title. */
  readonly title: string;
  /** Already-translated sentence describing what is about to happen. */
  readonly description: string;
  /** Already-translated label for the confirming button. */
  readonly confirmLabel: string;
  readonly destructive?: boolean;
  readonly busy?: boolean;
  /** Extra detail rendered above the reason field (a diff, a value, a warning). */
  readonly children?: ReactNode;
}

/**
 * Every risky or destructive action in the governance cluster goes through
 * this: a modal that states what will happen and REFUSES to submit without a
 * written reason.
 *
 * The reason is not decoration. `POST /killswitch` and the four-eyes parameter
 * queue both record it in the audit chain, and an audit entry whose reason
 * field is empty is the one an auditor asks about six months later. Requiring
 * it in the client also makes the dangerous button a two-step action, which is
 * the point: nobody stops the platform by brushing a key.
 */
export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  destructive = false,
  busy = false,
  children,
}: ConfirmModalProps): ReactNode {
  const t = useT();
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);

  // A stale reason must never be carried into the next confirmation: the modal
  // is reused for different actions and the audit trail would record the text
  // typed for a decision the operator already abandoned.
  useEffect(() => {
    if (!open) {
      setReason("");
      setTouched(false);
    }
  }, [open]);

  const trimmed = reason.trim();
  const invalid = trimmed === "";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      closeLabel={t("action.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("action.cancel")}</Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            busy={busy}
            onClick={() => {
              setTouched(true);
              if (invalid) return;
              onConfirm(trimmed);
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="scr-prose">{description}</p>
      {children}
      <Input
        label={t("field.reason")}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        hint={t("field.reason_hint")}
        {...(touched && invalid ? { error: t("error.reason_required") } : {})}
      />
    </Modal>
  );
}
