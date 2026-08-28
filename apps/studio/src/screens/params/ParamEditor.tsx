import type { ParamDefinition } from "@maestro/contracts";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Badge, Button, Input, Modal, Select } from "../../ui/index.ts";
import { formatValue, KeyValue, type PendingParamChange } from "../common/index.ts";

export interface ParamEditorProps {
  readonly definition: ParamDefinition | null;
  readonly currentValue: unknown;
  readonly currentVersion: number;
  /** An open four-eyes proposal for this key, when one exists. */
  readonly pending: PendingParamChange | null;
  /** The signed-in account, used ONLY to label the button honestly. */
  readonly viewerUserId: string | null;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (value: unknown) => void;
}

/**
 * Is `proposedBy` the same PERSON as the viewer?
 *
 * Four-eyes counts people, not credentials: `ugur@corp` and `ai-via:ugur@corp`
 * are one pair of eyes holding two tokens (M32/M101), so the delegate prefix is
 * stripped before comparing — mirroring `humanBehind`/`samePerson` in
 * apps/bff/src/params-service.ts:148.
 *
 * This is PRESENTATION ONLY. The server decides, and it decides again on every
 * request; duplicating the rule here just stops the button from claiming an
 * outcome the server will refuse. When identity is unknown the answer is `false`
 * — "we cannot tell" must not silently become "this is a valid second pair of
 * eyes", so an uncertain case shows the cautious label.
 */
function isSelfProposal(proposedBy: string, viewerUserId: string | null): boolean {
  if (viewerUserId === null) return false;
  const person = (actor: string): string => actor.replace(/^ai-via:/, "").trim().toLowerCase();
  const viewer = person(viewerUserId);
  return viewer !== "" && person(proposedBy) === viewer;
}

/**
 * Editing one parameter (M71).
 *
 * A `guarded` key is NOT saved from here. The BFF turns the first write into a
 * proposal and answers 202; a second, different person has to send the same
 * value before it applies (M32/M78). The dialog says so before the operator
 * types, and the button reads "send for approval" rather than "save" — a
 * mislabelled button is how somebody believes a policy changed when it did not.
 */
export function ParamEditor({
  definition,
  currentValue,
  currentVersion,
  pending,
  viewerUserId,
  busy,
  onClose,
  onSubmit,
}: ParamEditorProps): ReactNode {
  const t = useT();
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    setDraft(definition === null ? "" : formatValue(currentValue));
    setInvalid(false);
  }, [definition, currentValue]);

  if (definition === null) return null;

  const guarded = definition.guarded;
  const ownProposal = pending !== null && isSelfProposal(pending.proposedBy, viewerUserId);
  /**
   * "Approve" is only truthful for a DIFFERENT person sending the SAME value.
   * The proposer re-sending their own value is not an approval — the BFF treats
   * it as an amendment and answers `status: "pending"` again
   * (params-service.ts:82). Labelling that button "Approve the change" is how an
   * operator walks away believing a guarded parameter is live when it is still
   * waiting: the most dangerous possible misreading of the four-eyes rule.
   */
  const confirming =
    pending !== null && guarded && !ownProposal && formatValue(pending.value) === draft.trim();

  const submit = (): void => {
    const parsed = parseDraft(definition, draft);
    if (parsed.ok) {
      setInvalid(false);
      onSubmit(parsed.value);
      return;
    }
    setInvalid(true);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t("params.edit.title")}
      closeLabel={t("action.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("action.cancel")}</Button>
          <Button variant="primary" busy={busy} onClick={submit}>
            {guarded
              ? confirming
                ? t("params.action.approve_change")
                : t("params.action.propose")
              : t("action.save")}
          </Button>
        </>
      }
    >
      <KeyValue
        entries={[
          { label: t("params.col.key"), value: <code className="scr-mono">{definition.key}</code> },
          { label: t("params.col.scope"), value: t(`params.scope.${definition.scope}`) },
          { label: t("params.col.type"), value: t(`params.type.${definition.type}`) },
          {
            label: t("params.field.current", { version: String(currentVersion) }),
            value: <span className="scr-mono">{formatValue(currentValue)}</span>,
          },
        ]}
      />

      <p className="scr-prose">{t(definition.descriptionKey)}</p>

      {guarded && (
        <div className="scr-note scr-note--warn">
          <Badge tone="amber">{t("params.badge.guarded")}</Badge>{" "}
          {pending === null
            ? t("params.guarded.explain")
            : ownProposal
              ? // The proposer needs to know the wait is on someone else, not
                // on them clicking again.
                t("params.guarded.own_proposal")
              : t("params.guarded.pending_explain", { by: pending.proposedBy })}
        </div>
      )}

      {definition.type === "enum" ? (
        <Select
          label={t("params.field.new_value")}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          options={(definition.enumValues ?? []).map((option) => ({
            value: option,
            label: option,
          }))}
          {...(invalid ? { error: t("params.error.value_type") } : {})}
        />
      ) : (
        <Input
          label={t("params.field.new_value")}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          hint={t(`params.hint.${definition.type}`)}
          {...(invalid ? { error: t("params.error.value_type") } : {})}
        />
      )}
    </Modal>
  );
}

type Parsed = { ok: true; value: unknown } | { ok: false };

/**
 * The field is text; the parameter has a type. Parsing client-side is a
 * courtesy — the BFF re-checks every value and answers `param_value` — but it
 * turns "expected finite number" into a message beside the field instead of a
 * toast after a round trip.
 */
function parseDraft(definition: ParamDefinition, raw: string): Parsed {
  const text = raw.trim();
  switch (definition.type) {
    case "string":
      return text === "" ? { ok: false } : { ok: true, value: text };
    case "number": {
      const value = Number(text);
      return text !== "" && Number.isFinite(value) ? { ok: true, value } : { ok: false };
    }
    case "boolean":
      if (text === "true") return { ok: true, value: true };
      if (text === "false") return { ok: true, value: false };
      return { ok: false };
    case "enum":
      return (definition.enumValues ?? []).includes(text) ? { ok: true, value: text } : { ok: false };
    case "json":
      try {
        return { ok: true, value: JSON.parse(text) as unknown };
      } catch {
        return { ok: false };
      }
  }
}
