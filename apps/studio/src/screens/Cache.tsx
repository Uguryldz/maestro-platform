import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Card, Kpi, Table } from "../ui/index.ts";
import { useEnumLabel } from "./common/label.ts";
import { MaybeUnwired } from "./shared/unwired.tsx";

/**
 * Screen: cache — the three cache layers and the live ticket workspaces.
 *
 * A workspace survives as long as its ticket is open, so an old workspace is
 * usually a ticket parked at a human gate, not waste. Idle age is therefore
 * shown plainly rather than flagged as an error.
 */

interface CacheLayer {
  readonly layerId: string;
  /** What the cache is keyed on. */
  readonly keyedBy: string;
  readonly entries: number;
  readonly bytes: number;
  readonly note: string;
}

interface Workspace {
  readonly ticketKey: string;
  readonly runnerId: string;
  readonly bytes: number;
  /** "resumable" | "human_working" | "sleeping" */
  readonly sessionState: string;
  readonly lastAccessAt: string;
  readonly idleDays: number;
}

interface CacheResponse {
  readonly layers: readonly CacheLayer[];
  readonly workspaces: readonly Workspace[];
  /** Days of inactivity after which a workspace is evicted (M65). */
  readonly evictionAfterDays: number;
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function CacheScreen(): ReactNode {
  const t = useT();
  const api = useApi();
  const enumLabel = useEnumLabel();

  const query = useQuery({
    queryKey: ["cache"],
    queryFn: ({ signal }) => api.get<CacheResponse>("/cache", { signal }),
  });

  const data = query.data;

  return (
    <>
      <Card title={t("cache.layers")} subtitle={t("cache.layers_sub")}>
        <MaybeUnwired
          isPending={query.isPending}
          error={query.error}
          isEmpty={(data?.layers ?? []).length === 0}
          emptyTitle={t("cache.no_layers")}
          onRetry={() => void query.refetch()}
        >
          <div className="tpl-chips">
            {(data?.layers ?? []).map((layer) => (
              <Kpi
                key={layer.layerId}
                label={t(`cache.layer.${layer.layerId}`)}
                value={t("cache.entries_size", {
                  n: String(layer.entries),
                  size: gib(layer.bytes),
                })}
                note={layer.note}
              />
            ))}
          </div>
        </MaybeUnwired>
      </Card>

      <div style={{ marginTop: 14 }}>
        <Card title={t("cache.workspaces")} subtitle={t("cache.workspaces_sub")} padded={false}>
          <MaybeUnwired
            isPending={query.isPending}
            error={query.error}
            isEmpty={(data?.workspaces ?? []).length === 0}
            emptyTitle={t("cache.no_workspaces")}
          >
            <Table
              columns={[
                {
                  key: "ticket",
                  header: t("cache.col.ticket"),
                  cell: (row: Workspace) => row.ticketKey,
                },
                { key: "runner", header: t("cache.col.runner"), cell: (row) => row.runnerId },
                {
                  key: "size",
                  header: t("cache.col.size"),
                  cell: (row) => gib(row.bytes),
                  align: "right",
                },
                {
                  key: "session",
                  header: t("cache.col.session"),
                  cell: (row) => (
                    <Badge tone={row.sessionState === "sleeping" ? "amber" : "gray"}>
                      {enumLabel("cache.session", row.sessionState).text}
                    </Badge>
                  ),
                },
                { key: "last", header: t("cache.col.last_access"), cell: (row) => row.lastAccessAt },
                {
                  key: "idle",
                  header: t("cache.col.idle"),
                  cell: (row) => t("cache.n_days", { n: String(row.idleDays) }),
                  align: "right",
                },
              ]}
              rows={data?.workspaces ?? []}
              rowKey={(row) => row.ticketKey}
              emptyLabel={t("cache.no_workspaces")}
            />
          </MaybeUnwired>
        </Card>
      </div>

      {data !== undefined && (
        <p className="tpl-keyline" style={{ marginTop: 12 }}>
          {t("cache.eviction_note", { n: String(data.evictionAfterDays) })}
        </p>
      )}
    </>
  );
}
