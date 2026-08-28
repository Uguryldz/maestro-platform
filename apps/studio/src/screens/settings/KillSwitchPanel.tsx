import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { messageKeyOf } from "../../api/errors.ts";
import { useApi, useAuth } from "../../auth/AuthProvider.tsx";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Badge, Button, Card, useToast } from "../../ui/index.ts";
import {
  ConfirmModal,
  type KillSwitchLevel,
  type KillSwitchResult,
  type KillSwitchState,
  KeyValue,
  QueryState,
} from "../common/index.ts";

const TONE: Readonly<Record<KillSwitchLevel, "green" | "amber" | "red">> = {
  off: "green",
  intake_only: "amber",
  all: "red",
};

const LEVEL_KEY: Readonly<Record<KillSwitchLevel, string>> = {
  off: "killswitch.level.off",
  intake_only: "killswitch.level.intake_only",
  all: "killswitch.level.all",
};

/**
 * The kill switch (M58), which is the most dangerous control in the product:
 * `intake_only` stops new work, `all` stops running sandboxes too.
 *
 * Deliberately NOT a toggle. The mock draws two switches; a switch is a control
 * you flip by brushing it, and this one halts a bank's delivery pipeline. Each
 * level is a button that opens a confirmation naming the exact consequence and
 * refusing to submit without a written reason — the same reason the BFF writes
 * into the audit chain. maestro-mcp cannot reach this at all: M101 gives it
 * `propose_killswitch`, and a delegated session is refused here
 * (`human_channel_only`), so the control is hidden for one rather than shown
 * and then rejected.
 */
export function KillSwitchPanel(): ReactNode {
  const api = useApi();
  const t = useT();
  const toast = useToast();
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const [proposed, setProposed] = useState<KillSwitchLevel | null>(null);

  const state = useQuery({
    queryKey: ["killswitch"],
    queryFn: ({ signal }) => api.get<KillSwitchState>("/killswitch", { signal }),
  });

  const operate = useMutation({
    mutationFn: (input: { level: KillSwitchLevel; reason: string }) =>
      api.post<KillSwitchResult>("/killswitch", input),
    onSuccess: (result) => {
      setProposed(null);
      void queryClient.invalidateQueries({ queryKey: ["killswitch"] });
      toast.show(
        result.state.level === "off" ? "success" : "warning",
        t("killswitch.toast.applied", {
          level: t(LEVEL_KEY[result.state.level]),
          stopped: String(result.stopped.length),
        }),
      );
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  // Fail closed: an unknown role or a delegated (AI-held) session gets no
  // control at all. The BFF refuses both anyway; showing a button that always
  // 403s teaches operators to ignore errors.
  const isAdmin = session?.roles.includes("admin") ?? false;
  const delegated = session?.delegated ?? false;
  const mayOperate = isAdmin && !delegated;

  return (
    <Card title={t("killswitch.card.title")} subtitle={t("killswitch.card.sub")}>
      <QueryState
        isPending={state.isPending}
        error={state.error}
        skeletonRows={3}
        onRetry={() => void state.refetch()}
      >
        {state.data !== undefined && (
          <>
            <KeyValue
              entries={[
                {
                  label: t("killswitch.field.state"),
                  value: (
                    <Badge tone={TONE[state.data.level]} icon="●">
                      {t(LEVEL_KEY[state.data.level])}
                    </Badge>
                  ),
                },
                { label: t("killswitch.field.actor"), value: state.data.actor },
                { label: t("killswitch.field.reason"), value: state.data.reason },
              ]}
            />

            {mayOperate ? (
              <div className="scr-stack" style={{ marginTop: 14 }}>
                <LevelRow
                  titleKey="killswitch.level1.title"
                  descriptionKey="killswitch.level1.desc"
                  actionKey="killswitch.action.pause_intake"
                  active={state.data.level === "intake_only"}
                  onClick={() => setProposed("intake_only")}
                />
                <LevelRow
                  titleKey="killswitch.level2.title"
                  descriptionKey="killswitch.level2.desc"
                  actionKey="killswitch.action.stop_all"
                  destructive
                  active={state.data.level === "all"}
                  onClick={() => setProposed("all")}
                />
                {state.data.level !== "off" && (
                  <LevelRow
                    titleKey="killswitch.resume.title"
                    descriptionKey="killswitch.resume.desc"
                    actionKey="killswitch.action.resume"
                    active={false}
                    onClick={() => setProposed("off")}
                  />
                )}
              </div>
            ) : (
              <div className="scr-note" style={{ marginTop: 14 }}>
                {delegated ? t("killswitch.note.delegated") : t("killswitch.note.admin_only")}
              </div>
            )}
          </>
        )}
      </QueryState>

      <ConfirmModal
        open={proposed !== null}
        onClose={() => setProposed(null)}
        onConfirm={(reason) => {
          if (proposed !== null) operate.mutate({ level: proposed, reason });
        }}
        title={t("killswitch.confirm.title")}
        description={proposed === null ? "" : t(`killswitch.confirm.${proposed}`)}
        confirmLabel={proposed === null ? "" : t(`killswitch.action.${ACTION_KEY[proposed]}`)}
        destructive={proposed !== "off"}
        busy={operate.isPending}
      >
        <div className="scr-note scr-note--danger">{t("killswitch.confirm.audit_warning")}</div>
      </ConfirmModal>
    </Card>
  );
}

const ACTION_KEY: Readonly<Record<KillSwitchLevel, string>> = {
  off: "resume",
  intake_only: "pause_intake",
  all: "stop_all",
};

function LevelRow(props: {
  readonly titleKey: string;
  readonly descriptionKey: string;
  readonly actionKey: string;
  readonly active: boolean;
  readonly destructive?: boolean;
  readonly onClick: () => void;
}): ReactNode {
  const t = useT();
  return (
    <div className="scr-toggle-row">
      <div className="scr-toggle-row__text">
        <div className="scr-toggle-row__title">{t(props.titleKey)}</div>
        <div className="scr-mini">{t(props.descriptionKey)}</div>
      </div>
      {props.active ? (
        <Badge tone="red">{t("killswitch.badge.active")}</Badge>
      ) : (
        <Button size="sm" variant={props.destructive === true ? "danger" : "default"} onClick={props.onClick}>
          {t(props.actionKey)}
        </Button>
      )}
    </div>
  );
}
