import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Card, Table } from "../ui/index.ts";
import type { BadgeTone, Column } from "../ui/index.ts";
import type { Page, SandboxRecord, SandboxState } from "./common/index.ts";
import { QueryState, useEnumLabel } from "./common/index.ts";
import { ageLabel, byteSize } from "./shared/format.ts";

const STATE_TONE: Readonly<Record<SandboxState, BadgeTone>> = {
  active: "green",
  resumable: "blue",
  human_held: "orange",
};

/**
 * Three states exist today. A fourth added server-side would, with a bare
 * `t()`, throw and blank the whole fleet view — hiding every sandbox an
 * operator can still act on. Unknown states render grey and marked instead.
 */
function stateTone(state: string): BadgeTone {
  return Object.hasOwn(STATE_TONE, state) ? STATE_TONE[state as SandboxState] : "gray";
}

/**
 * Live sandboxes and the workspaces they left behind (M31/M65).
 *
 * Two deliberate absences. There is no session TRANSCRIPT: a live agent's
 * output can carry unmasked ticket text (PII, M18), the BFF exposes no log
 * endpoint, and inventing one would be worse than omitting it. And there is no
 * DELETE control: an idle workspace is archived by the retention job on its own
 * schedule, while a delete button in an operator's hand is how somebody
 * destroys the session a human was working in — which is why `human_held` is
 * rendered as its own state rather than folded into "idle".
 */
export function SandboxScreen(): ReactNode {
  const api = useApi();
  const t = useT();
  const enumLabel = useEnumLabel();

  const sandboxes = useQuery({
    queryKey: ["studio-sandboxes"],
    queryFn: ({ signal }) => api.get<Page<SandboxRecord>>("/studio/sandboxes", { signal }),
    refetchInterval: 30_000,
  });

  const rows = sandboxes.data?.items ?? [];

  const columns: readonly Column<SandboxRecord>[] = [
    {
      key: "ticket",
      header: t("sandbox.col.ticket"),
      cell: (row) => <b className="scr-mono">{row.ticketKey}</b>,
    },
    {
      key: "runner",
      header: t("sandbox.col.runner"),
      cell: (row) => <span className="scr-mono">{row.runnerId}</span>,
    },
    {
      key: "state",
      header: t("sandbox.col.session"),
      cell: (row) => {
        const label = enumLabel("sandbox.state", row.state);
        return (
          <Badge tone={label.unknown ? "gray" : stateTone(row.state)}>{label.text}</Badge>
        );
      },
    },
    {
      key: "size",
      header: t("sandbox.col.size"),
      cell: (row) => {
        const size = byteSize(row.sizeBytes);
        return (
          <span className="scr-mono">
            {size.value} {t(size.key)}
          </span>
        );
      },
      align: "right",
    },
    {
      key: "last",
      header: t("sandbox.col.last_access"),
      cell: (row) => {
        const age = ageLabel(row.lastAccessAt);
        return <span className="scr-mini">{age === null ? "—" : t(age.key, age.params)}</span>;
      },
      align: "right",
    },
  ];

  return (
    <div className="scr-stack">
      <QueryState
        isPending={sandboxes.isPending}
        error={sandboxes.error}
        isEmpty={rows.length === 0}
        emptyTitle={t("sandbox.empty.title")}
        emptyDescription={t("sandbox.empty.description")}
        emptyIcon="▶"
        onRetry={() => void sandboxes.refetch()}
      >
        <Card
          title={t("sandbox.card.sessions")}
          subtitle={t("sandbox.card.sessions_sub")}
          padded={false}
        >
          <Table
            columns={columns}
            rows={rows}
            rowKey={(row) => `${row.ticketKey}:${row.runnerId}`}
            emptyLabel={t("sandbox.empty.title")}
            caption={t("sandbox.card.sessions")}
          />
        </Card>
      </QueryState>

      <div className="scr-note">{t("sandbox.note.no_transcript")}</div>
      <div className="scr-note">{t("sandbox.note.no_delete")}</div>
    </div>
  );
}
