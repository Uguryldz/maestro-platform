import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Badge, Button, Input, Modal } from "../../ui/index.ts";
import { useLabel } from "../common/label.ts";
import type {
  EscalationLadderRaw,
  EscalationLadderStep,
  NotifyChannel,
  NotifyRouting,
  NotifyUpdate,
} from "../common/index.ts";

const CHANNELS: readonly NotifyChannel[] = ["teams", "smtp", "jira", "slack"];

export interface NotifyEditorProps {
  readonly open: boolean;
  readonly ladder: EscalationLadderRaw;
  readonly routing: NotifyRouting;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (update: NotifyUpdate) => void;
}

/**
 * Editing the escalation ladder and channel routing together (M45/M88).
 *
 * Only the THRESHOLDS and the CHANNELS are editable here, never a step's `id`
 * or `event`: the id is what `firedStepIds` remembers, so changing a 72h rung
 * to 48h must carry the same id or every open gate re-escalates. The two are
 * saved together because they are read together — moving escalation off Teams
 * touches the routing map and the rung that names the channel, and applying one
 * without the other points a rung at a channel nobody watches.
 */
export function NotifyEditor({
  open,
  ladder,
  routing,
  busy,
  onClose,
  onSubmit,
}: NotifyEditorProps): ReactNode {
  const t = useT();
  const label = useLabel();
  const [steps, setSteps] = useState<readonly EscalationLadderStep[]>(ladder.steps ?? []);
  const [defaultChannels, setDefaultChannels] = useState<readonly NotifyChannel[]>(
    routing.default ?? [],
  );
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    if (open) {
      setSteps(ladder.steps ?? []);
      setDefaultChannels(routing.default ?? []);
      setInvalid(false);
    }
  }, [open, ladder, routing]);

  if (!open) return null;

  const setHours = (id: string, raw: string): void => {
    const value = Number(raw);
    setSteps((current) =>
      current.map((step) => (step.id === id ? { ...step, afterHours: value } : step)),
    );
  };

  const setChannel = (id: string, channel: NotifyChannel): void =>
    setSteps((current) =>
      current.map((step) => (step.id === id ? { ...step, channel } : step)),
    );

  const toggleDefault = (channel: NotifyChannel): void =>
    setDefaultChannels((current) =>
      current.includes(channel)
        ? current.filter((entry) => entry !== channel)
        : [...current, channel],
    );

  const submit = (): void => {
    const bad = steps.some((step) => !Number.isFinite(step.afterHours) || step.afterHours <= 0);
    if (bad || defaultChannels.length === 0) {
      setInvalid(true);
      return;
    }
    onSubmit({
      ladder: { ...ladder, steps },
      routing: { ...routing, default: defaultChannels },
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t("notify.edit.title")}
      closeLabel={t("action.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("action.cancel")}</Button>
          <Button variant="primary" busy={busy} onClick={submit}>
            {t("action.save")}
          </Button>
        </>
      }
    >
      <p className="scr-prose">{t("notify.edit.explain")}</p>

      <h4 className="scr-mini">{t("notify.edit.steps")}</h4>
      {steps.map((step) => (
        <div key={step.id} className="scr-row" style={{ marginBottom: 8 }}>
          <Badge tone={step.action === "delegate" ? "amber" : "blue"}>
            {label(`notify.step.event.${step.event}`, step.event)}
          </Badge>
          <Input
            label={t("notify.edit.after_hours")}
            type="number"
            value={String(step.afterHours)}
            onChange={(event) => setHours(step.id, event.target.value)}
            {...(invalid && (!Number.isFinite(step.afterHours) || step.afterHours <= 0)
              ? { error: t("notify.edit.error.hours") }
              : {})}
          />
          <div className="scr-row">
            {CHANNELS.map((channel) => (
              <button
                key={channel}
                type="button"
                className={
                  step.channel === channel ? "scr-step scr-step--on" : "scr-step scr-step--pending"
                }
                onClick={() => setChannel(step.id, channel)}
              >
                {t(`notify.channel.${channel}`)}
              </button>
            ))}
          </div>
        </div>
      ))}

      <h4 className="scr-mini" style={{ marginTop: 14 }}>
        {t("notify.edit.default_channels")}
      </h4>
      <div className="scr-row">
        {CHANNELS.map((channel) => (
          <button
            key={channel}
            type="button"
            className={
              defaultChannels.includes(channel)
                ? "scr-step scr-step--on"
                : "scr-step scr-step--pending"
            }
            onClick={() => toggleDefault(channel)}
          >
            {t(`notify.channel.${channel}`)}
          </button>
        ))}
      </div>
      {invalid && defaultChannels.length === 0 && (
        <div className="scr-note scr-note--warn" style={{ marginTop: 9 }}>
          {t("notify.edit.error.no_channel")}
        </div>
      )}
    </Modal>
  );
}
