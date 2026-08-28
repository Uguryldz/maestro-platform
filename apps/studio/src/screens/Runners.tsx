import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { ReactNode } from "react";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Card, Kpi, Table } from "../ui/index.ts";
import type { BadgeTone, Column } from "../ui/index.ts";
import type { PoolSummary, RunnerRecord, RunnersResponse, RunnerState } from "./common/index.ts";
import { useLabel } from "./common/label.ts";
import { MaybeUnwired } from "./shared/unwired.tsx";

const STATE_TONE: Readonly<Record<RunnerState, BadgeTone>> = {
  idle: "green",
  busy: "blue",
  draining: "amber",
  unreachable: "red",
};

/**
 * The runner fleet (M60): where the agents' sandboxes actually execute.
 *
 * `unreachable` machines are sorted to the TOP and called out in a banner. A
 * node that stopped answering is not a node with no problems — it is the one
 * whose jobs are silently not running, and the natural ordering would bury it
 * under healthy hosts.
 *
 * The BFF already sums per-pool capacity in `/studio/runners`, and this screen
 * renders those numbers rather than recomputing them: two different totals for
 * the same fleet is worse than either one. It adds only what the server does
 * not send — how many of a pool's machines are unreachable — so a tile reading
 * "4/16" cannot look like spare capacity while half the fleet is dark.
 */
export function RunnersScreen(): ReactNode {
  const api = useApi();
  const t = useT();
  const label = useLabel();

  const runners = useQuery({
    queryKey: ["studio-runners"],
    queryFn: ({ signal }) => api.get<RunnersResponse>("/studio/runners", { signal }),
    refetchInterval: 30_000,
  });

  const nodes = useMemo(() => sortByUrgency(runners.data?.items ?? []), [runners.data]);
  const pools = useMemo(
    () => withUnreachable(runners.data?.pools ?? [], nodes),
    [runners.data, nodes],
  );
  const unreachable = nodes.filter((node) => node.state === "unreachable").length;

  const columns: readonly Column<RunnerRecord>[] = [
    {
      key: "id",
      header: t("runners.col.machine"),
      cell: (row) => (
        <div>
          <b className="scr-mono">{row.runnerId}</b>
          <div className="scr-mini">{row.pool}</div>
        </div>
      ),
    },
    {
      key: "platform",
      header: t("runners.col.pool"),
      cell: (row) => <Badge tone="blue">{label(`platform.${row.platform}`, row.platform)}</Badge>,
    },
    {
      key: "slots",
      header: t("runners.col.slots"),
      cell: (row) => (
        <span className="scr-mono">
          {row.activeSandboxes}/{row.capacity}
        </span>
      ),
      align: "right",
    },
    {
      key: "state",
      header: t("runners.col.status"),
      cell: (row) => (
        <div>
          <Badge tone={STATE_TONE[row.state]} icon="●">
            {label(`runners.state.${row.state}`, row.state)}
          </Badge>
          {row.note !== null && <div className="scr-mini">{label(row.note, row.runnerId)}</div>}
        </div>
      ),
    },
  ];

  return (
    <div className="scr-stack">
      <MaybeUnwired
        isPending={runners.isPending}
        error={runners.error}
        isEmpty={nodes.length === 0}
        emptyTitle={t("runners.empty")}
        emptyIcon="🖥"
        onRetry={() => void runners.refetch()}
      >
        {unreachable > 0 && (
          <div className="scr-note scr-note--danger">
            {t("runners.alert.unreachable", { count: String(unreachable) })}
          </div>
        )}

        <div className="scr-grid scr-grid--3">
          {pools.map((pool) => (
            <Kpi
              key={pool.pool}
              label={pool.pool}
              value={`${pool.busy}/${pool.capacity}`}
              note={
                pool.unreachable > 0
                  ? t("runners.kpi.note_unreachable", {
                      machines: String(pool.machines),
                      unreachable: String(pool.unreachable),
                    })
                  : t("runners.kpi.note_healthy", { machines: String(pool.machines) })
              }
            />
          ))}
        </div>

        <Card
          title={t("runners.card.machines")}
          subtitle={t("runners.card.machines_sub")}
          padded={false}
        >
          <Table
            columns={columns}
            rows={nodes}
            rowKey={(row) => row.runnerId}
            emptyLabel={t("runners.empty")}
            caption={t("runners.card.machines")}
          />
        </Card>
      </MaybeUnwired>

      <div className="scr-grid scr-grid--2">
        <Card title={t("runners.card.isolation")}>
          <dl className="scr-kv">
            {(["linux", "windows_macos", "network", "identity"] as const).map((row) => (
              <div key={row} style={{ display: "contents" }}>
                <dt>{t(`runners.isolation.${row}`)}</dt>
                <dd>{t(`runners.isolation.${row}.value`)}</dd>
              </div>
            ))}
          </dl>
        </Card>
        <Card title={t("runners.card.accepted_risk")}>
          <p className="scr-prose">{t("runners.accepted_risk.body")}</p>
        </Card>
      </div>
    </div>
  );
}

/** Unreachable first, then draining, then the working machines. */
function sortByUrgency(nodes: readonly RunnerRecord[]): readonly RunnerRecord[] {
  const rank: Readonly<Record<RunnerState, number>> = {
    unreachable: 0,
    draining: 1,
    busy: 2,
    idle: 3,
  };
  return [...nodes].sort((left, right) => {
    const byState = rank[left.state] - rank[right.state];
    return byState !== 0 ? byState : left.runnerId.localeCompare(right.runnerId);
  });
}

/** The server's pool totals plus the count of machines nobody can reach. */
function withUnreachable(
  pools: readonly PoolSummary[],
  nodes: readonly RunnerRecord[],
): readonly (PoolSummary & { unreachable: number })[] {
  return pools.map((pool) => ({
    ...pool,
    unreachable: nodes.filter((node) => node.pool === pool.pool && node.state === "unreachable")
      .length,
  }));
}
