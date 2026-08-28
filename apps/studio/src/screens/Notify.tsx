import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { messageKeyOf } from "../api/errors.ts";
import { useApi, useAuth } from "../auth/AuthProvider.tsx";
import { hasRole } from "../auth/types.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Input, Table, useToast } from "../ui/index.ts";
import type { BadgeTone, Column } from "../ui/index.ts";
import {
  type Delegation,
  NOTIFY_EVENTS,
  type NotifyChannel,
  type NotifyUpdate,
  type NotifyView,
  type ParamPutResult,
  useDuration,
  type WaitingGate,
} from "./common/index.ts";
import { useEnumLabel, useLabel } from "./common/label.ts";
import { MaybeUnwired, UnwiredNote } from "./shared/unwired.tsx";
import { NotifyEditor } from "./notify/NotifyEditor.tsx";

/**
 * Reminders and escalation (M45/M88): the ladder that keeps a gate from being
 * forgotten, who a decision falls to when its owner is away, and what is
 * waiting right now.
 *
 * No rung of the ladder auto-rejects. A pause is not a decision (M29), so the
 * last step is a report to a human, never a timeout that closes the gate — the
 * screen says so, because an operator who assumes an unanswered gate eventually
 * resolves itself stops chasing it.
 */
export function NotifyScreen(): ReactNode {
  const api = useApi();
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const label = useLabel();
  const enumLabel = useEnumLabel();
  const duration = useDuration();

  const [editing, setEditing] = useState(false);

  const notify = useQuery({
    queryKey: ["notify"],
    queryFn: ({ signal }) => api.get<NotifyView>("/notify", { signal }),
  });

  const canEdit = hasRole(session, "admin");

  // PUT /notify answers `{ results: [...] }`; a guarded parameter comes back
  // `pending`, so a save is only truly applied when NONE of the results is.
  const save = useMutation({
    mutationFn: (update: NotifyUpdate) =>
      api.put<{ results: readonly ParamPutResult[] }>("/notify", update),
    onSuccess: ({ results }) => {
      setEditing(false);
      const anyPending = results.some((result) => result.status === "pending");
      if (anyPending) {
        toast.show("warning", t("notify.edit.toast.pending"));
      } else {
        void queryClient.invalidateQueries({ queryKey: ["notify"] });
        toast.show("success", t("notify.edit.toast.saved"));
      }
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  // The channels that actually deliver in this deployment. `jira` is always
  // wired; `teams` once its webhook connector is set. `smtp`/`slack` are coded
  // but not wired at runtime, so a rule naming them is shown but marked pasif —
  // honest about what would fire vs. what is only configured.
  const ACTIVE_CHANNELS: ReadonlySet<NotifyChannel> = new Set<NotifyChannel>(["jira", "teams"]);

  const routingColumns: readonly Column<{
    event: string;
    channels: readonly NotifyChannel[];
    explicit: boolean;
  }>[] = [
    {
      key: "event",
      header: t("notify.col.event"),
      cell: (row) => (
        <div>
          <b>{label(`notify.event.${row.event}`, row.event)}</b>
          {!row.explicit && <span className="scr-mini"> · {t("notify.routing.uses_default")}</span>}
        </div>
      ),
    },
    {
      key: "channels",
      header: t("notify.col.channels"),
      cell: (row) =>
        row.channels.length === 0 ? (
          <Badge tone="gray">{t("notify.routing.muted")}</Badge>
        ) : (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {row.channels.map((channel) => {
              const active = ACTIVE_CHANNELS.has(channel);
              return (
                <Badge key={channel} tone={active ? "green" : "gray"}>
                  {label(`notify.channel.${channel}`, channel)}
                  {active ? "" : ` · ${t("notify.routing.pasif")}`}
                </Badge>
              );
            })}
          </div>
        ),
    },
  ];

  const delegationColumns: readonly Column<Delegation>[] = [
    { key: "role", header: t("notify.col.role"), cell: (row) => enumLabel("role", row.role).text },
    { key: "primary", header: t("notify.col.primary"), cell: (row) => row.primary },
    {
      key: "backup",
      header: t("notify.col.backup"),
      cell: (row) => row.backup ?? <span className="scr-mini">{t("notify.value.none")}</span>,
    },
    {
      key: "last",
      header: t("notify.col.last_resort"),
      cell: (row) => row.lastResort ?? <span className="scr-mini">{t("notify.value.none")}</span>,
    },
  ];

  const waitingColumns: readonly Column<WaitingGate>[] = [
    {
      key: "ticket",
      header: t("notify.col.ticket"),
      cell: (row) => <b className="scr-mono">{row.ticketKey}</b>,
    },
    {
      key: "step",
      header: t("notify.col.step"),
      cell: (row) => label(`notify.step.${row.step}`, row.step),
    },
    {
      key: "waiting",
      header: t("notify.col.waiting"),
      cell: (row) => (
        <Badge tone={waitingTone(row.waitingHours)}>{duration(row.waitingHours)}</Badge>
      ),
      align: "right",
    },
    {
      key: "last_action",
      header: t("notify.col.last_action"),
      cell: (row) => (
        <span className="scr-mini">
          {row.lastActionKey === null
            ? "—"
            : label(row.lastActionKey, "—", row.lastActionParams ?? {})}
        </span>
      ),
    },
  ];

  return (
    <div className="scr-stack">
      {/* Honest strip: the settings below persist, but no channel actually
          delivers yet — an operator must not rely on a reminder arriving. */}
      <UnwiredNote>{t("notify.unwired_note")}</UnwiredNote>

      {/* A plain-language intro: what this whole page decides. */}
      <Card title={t("notify.intro.title")}>
        <p className="scr-prose" style={{ margin: 0 }}>{t("notify.intro.body")}</p>
      </Card>

      <MaybeUnwired
        isPending={notify.isPending}
        error={notify.error}
        onRetry={() => void notify.refetch()}
      >
        {/* 1 · Which event goes to which channel — the most-asked question, so
            it leads. The routing map decides the channels per event; a blank
            entry follows `default`, an empty list is muted DELIBERATELY. */}
        {notify.data !== undefined && (
          <Card
            title={t("notify.card.routing")}
            subtitle={t("notify.card.routing_sub")}
            actions={
              canEdit ? (
                <Button size="sm" variant="primary" onClick={() => setEditing(true)}>
                  {t("notify.routing.edit")}
                </Button>
              ) : undefined
            }
            padded={false}
          >
            <Table
              columns={routingColumns}
              rows={NOTIFY_EVENTS.map((event) => ({
                event,
                channels: notify.data!.routing.byEvent[event] ?? notify.data!.routing.default,
                explicit: notify.data!.routing.byEvent[event] !== undefined,
              }))}
              rowKey={(row) => row.event}
              emptyLabel=""
              caption={t("notify.card.routing")}
            />
            <div className="scr-note" style={{ margin: "10px 14px 14px" }}>
              {t("notify.routing.channel_status")}
            </div>
          </Card>
        )}

        {/* 2 · Approvals waiting right now. */}
        <Card title={t("notify.card.waiting")} subtitle={t("notify.card.waiting_sub")} padded={false}>
          <Table
            columns={waitingColumns}
            rows={notify.data?.waiting ?? []}
            rowKey={(row) => `${row.ticketKey}:${row.step}`}
            emptyLabel={t("notify.empty.waiting")}
            caption={t("notify.card.waiting")}
          />
        </Card>

        {/* 3 · The reminder ladder — how a long-waiting approval escalates. */}
        <Card
          title={t("notify.card.ladder")}
          subtitle={t("notify.card.ladder_sub")}
          actions={
            canEdit && notify.data !== undefined ? (
              <Button size="sm" onClick={() => setEditing(true)}>
                {t("notify.edit.action")}
              </Button>
            ) : undefined
          }
        >
          {(notify.data?.ladder ?? []).length === 0 ? (
            <p className="scr-mini">{t("notify.empty.ladder")}</p>
          ) : (
            <div className="scr-ladder">
              {(notify.data?.ladder ?? []).map((step, index) => (
                <span key={`${step.kind}-${step.afterHours}`} className="scr-row">
                  {index > 0 && <span className="scr-arrow">→</span>}
                  <span
                    className={
                      step.kind === "notify" ? "scr-step scr-step--on" : "scr-step scr-step--pending"
                    }
                  >
                    {t(`notify.ladder.${step.kind}`, {
                      days: humanDays(step.afterHours, t),
                      channels: step.channels
                        .map((channel) => label(`notify.channel.${channel}`, channel))
                        .join(" + "),
                    })}
                  </span>
                </span>
              ))}
            </div>
          )}
          <div className="scr-note" style={{ marginTop: 12 }}>
            {t("notify.note.no_auto_reject")}
          </div>
        </Card>

        {/* 4 · The deputy chain — who a stuck approval falls to. */}
        <Card title={t("notify.card.delegation")} subtitle={t("notify.card.delegation_sub")} padded={false}>
          <Table
            columns={delegationColumns}
            rows={notify.data?.delegations ?? []}
            rowKey={(row) => row.role}
            emptyLabel={t("notify.empty.delegation")}
            caption={t("notify.card.delegation")}
          />
        </Card>

        {/* The Teams webhook entry (admin only) — belongs with channel setup. */}
        {notify.data !== undefined && canEdit && (
          <TeamsWebhookCard
            mask={notify.data.teamsWebhookMask}
            busy={save.isPending}
            onSave={(url) => save.mutate({ teamsWebhook: url })}
          />
        )}
      </MaybeUnwired>

      {notify.data !== undefined && (
        <NotifyEditor
          open={editing}
          ladder={notify.data.ladderRaw}
          routing={notify.data.routing}
          busy={save.isPending}
          onClose={() => setEditing(false)}
          onSubmit={(update) => save.mutate(update)}
        />
      )}
    </div>
  );
}

/** Colour by how long somebody has been waiting: a day, three days, longer. */
function waitingTone(hours: number): BadgeTone {
  if (hours >= 168) return "red";
  if (hours >= 72) return "amber";
  return "gray";
}

/**
 * A ladder threshold as a plain phrase: whole days read as "N gün", anything
 * else stays in hours. The ladder steps at 24/72/168h become "1 gün / 3 gün /
 * 7 gün" — the reading an operator has, not the raw hour count.
 */
function humanDays(hours: number, t: (key: string, params?: Record<string, string>) => string): string {
  if (hours % 24 === 0) {
    const days = hours / 24;
    return t("notify.duration.days", { n: String(days) });
  }
  return t("notify.duration.hours", { n: String(hours) });
}

/**
 * The Teams webhook URL entry (M45). The full URL is a bearer credential, so the
 * field starts EMPTY showing only the stored mask ("…<last 6>"); the admin types
 * a new URL to change it, and an empty submit clears it. The URL is never fetched
 * back to prefill — the server only ever hands out the mask.
 */
function TeamsWebhookCard({
  mask,
  busy,
  onSave,
}: {
  readonly mask: string;
  readonly busy: boolean;
  readonly onSave: (url: string) => void;
}): ReactNode {
  const t = useT();
  const [url, setUrl] = useState("");
  const isSet = mask !== "";
  return (
    <Card title={t("notify.teams.title")} subtitle={t("notify.teams.sub")}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 320px" }}>
          <Input
            label={t("notify.teams.field")}
            type="password"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder={isSet ? `${t("notify.teams.current")}: ${mask}` : "https://…webhook…"}
            hint={t("notify.teams.hint")}
          />
        </div>
        <Button variant="primary" busy={busy} onClick={() => onSave(url.trim())}>
          {t("notify.teams.save")}
        </Button>
        {isSet && (
          <Button busy={busy} onClick={() => onSave("")}>
            {t("notify.teams.clear")}
          </Button>
        )}
      </div>
    </Card>
  );
}
