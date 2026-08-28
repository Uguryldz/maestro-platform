import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Badge, Button, Input, Modal, Select } from "../../ui/index.ts";
import type {
  DataClassName,
  DataClassPolicy,
  OnpremFallback,
} from "../common/index.ts";

/** Data classes, most open first — the order the rules render in. */
const DATA_CLASSES: readonly DataClassName[] = ["acik", "dahili", "gizli"];
const FALLBACKS: readonly OnpremFallback[] = ["degrade_ai_assist", "block", "masked_cloud"];

export interface RoutingPolicyEditorProps {
  readonly open: boolean;
  /** The current policy, derived from the rules the screen already read. */
  readonly current: DataClassPolicy;
  /** An open four-eyes proposal on this guarded parameter, when one exists. */
  readonly pendingBy: string | null;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (policy: DataClassPolicy) => void;
}

/**
 * Editing the data-class routing policy (M99/M18).
 *
 * This parameter is GUARDED (M32/M78): it decides whether a `gizli` ticket may
 * be sent to a cloud model, so the first save files a PROPOSAL and a different
 * person must confirm the identical value before it applies. The dialog says so
 * up front and the button reads "send for approval", never "save" — a
 * mislabelled button is how somebody believes confidential tickets are routed
 * somewhere they are not yet.
 */
export function RoutingPolicyEditor({
  open,
  current,
  pendingBy,
  busy,
  onClose,
  onSubmit,
}: RoutingPolicyEditorProps): ReactNode {
  const t = useT();
  const [backends, setBackends] = useState<Record<DataClassName, string>>(current.backendByClass);
  const [fallback, setFallback] = useState<OnpremFallback>(current.whenOnpremMissing);
  const [invalid, setInvalid] = useState(false);

  // Reopening on a fresh policy must show that policy, not the last edit.
  useEffect(() => {
    if (open) {
      setBackends(current.backendByClass);
      setFallback(current.whenOnpremMissing);
      setInvalid(false);
    }
  }, [open, current]);

  if (!open) return null;

  const submit = (): void => {
    const trimmed = {
      acik: backends.acik.trim(),
      dahili: backends.dahili.trim(),
      gizli: backends.gizli.trim(),
    };
    if (trimmed.acik === "" || trimmed.dahili === "" || trimmed.gizli === "") {
      setInvalid(true);
      return;
    }
    onSubmit({ backendByClass: trimmed, whenOnpremMissing: fallback });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t("routing.policy.edit.title")}
      closeLabel={t("action.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("action.cancel")}</Button>
          <Button variant="primary" busy={busy} onClick={submit}>
            {t("routing.policy.action.propose")}
          </Button>
        </>
      }
    >
      <div className="scr-note scr-note--warn">
        <Badge tone="amber">{t("params.badge.guarded")}</Badge>{" "}
        {pendingBy === null
          ? t("routing.policy.guarded_explain")
          : t("routing.policy.pending_explain", { by: pendingBy })}
      </div>

      {DATA_CLASSES.map((dataClass) => (
        <Input
          key={dataClass}
          label={t("routing.policy.field.backend", { dataClass: t(`routing.data_class.${dataClass}`) })}
          value={backends[dataClass]}
          onChange={(event) =>
            setBackends((current) => ({ ...current, [dataClass]: event.target.value }))
          }
          hint={t("routing.policy.field.backend_hint")}
          {...(invalid && backends[dataClass].trim() === ""
            ? { error: t("routing.policy.error.required") }
            : {})}
        />
      ))}

      <Select
        label={t("routing.policy.field.fallback")}
        value={fallback}
        onChange={(event) => setFallback(event.target.value as OnpremFallback)}
        hint={t("routing.policy.field.fallback_hint")}
        options={FALLBACKS.map((option) => ({
          value: option,
          label: t(`routing.policy.fallback.${option}`),
        }))}
      />

      {/* The stored value, named — so a second approver confirming this proposal
          sees what it CHANGES, not just what it sets. A `block` quietly becoming
          `degrade_ai_assist` is the exact downgrade this line makes visible. */}
      <p className="scr-mini" style={{ marginTop: 8 }}>
        {t("routing.policy.field.fallback_current", {
          value: t(`routing.policy.fallback.${current.whenOnpremMissing}`),
        })}
        {fallback !== current.whenOnpremMissing && (
          <>
            {" "}
            <Badge tone="amber">{t("routing.policy.field.fallback_changed")}</Badge>
          </>
        )}
      </p>
    </Modal>
  );
}
