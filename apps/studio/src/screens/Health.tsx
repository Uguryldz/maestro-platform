import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Card, Table } from "../ui/index.ts";
import type { BadgeTone, Column } from "../ui/index.ts";
import type { HealthResponse, ServiceHealth, ServiceState } from "./common/index.ts";
import { QueryState } from "./common/index.ts";
import { useLabel } from "./common/label.ts";
import { ageLabel } from "./shared/format.ts";

const STATE_TONE: Readonly<Record<ServiceState, BadgeTone>> = {
  healthy: "green",
  degraded: "amber",
  down: "red",
  // Grey on purpose: "nobody set this up" is a to-do, not an alarm, and an
  // amber badge here would train operators to ignore amber.
  not_configured: "gray",
};

/**
 * Rows the operator can fix from the settings screen — the managed
 * connections (LLM / Jira / SCM). Anything else on this table is
 * infrastructure the settings screen cannot repair, so pointing there would
 * be a false trail.
 */
const CONNECTION_SERVICES: ReadonlySet<string> = new Set(["llm", "jira", "scm"]);

/**
 * Platform dependency health (M6) — the detail behind the unauthenticated
 * `/readyz` probe.
 *
 * The overall state comes from the BFF rather than being derived here: it
 * decides that `down` beats `degraded` beats `healthy`, and a client that
 * recomputed the same rule would eventually disagree with the alert that pages
 * somebody.
 *
 * The backup and restore-drill panel the mock draws is NOT rendered as data.
 * `/studio/health` reports service liveness only, and a "restore drill: never
 * run" line invented client-side would be the most dangerous kind of wrong: it
 * would look like a finding the platform is tracking (M66) when nothing is.
 */
export function HealthScreen(): ReactNode {
  const api = useApi();
  const t = useT();
  const label = useLabel();

  const health = useQuery({
    queryKey: ["studio-health"],
    queryFn: ({ signal }) => api.get<HealthResponse>("/studio/health", { signal }),
    refetchInterval: 60_000,
  });

  const services = health.data?.services ?? [];

  const columns: readonly Column<ServiceHealth>[] = [
    {
      key: "service",
      header: t("health.col.service"),
      // The id is the fallback: a component the catalog has not learned yet
      // must still appear, and it is the one worth noticing.
      cell: (row) => <b>{label(`health.service.${row.service}`, row.service)}</b>,
    },
    {
      key: "state",
      header: t("health.col.status"),
      cell: (row) => (
        <Badge tone={STATE_TONE[row.state]} icon="●">
          {label(`health.state.${row.state}`, row.state)}
        </Badge>
      ),
    },
    {
      key: "version",
      header: t("health.col.version"),
      cell: (row) => <span className="scr-mono scr-mini">{row.version}</span>,
    },
    {
      key: "checked",
      header: t("health.col.checked"),
      cell: (row) => {
        const age = ageLabel(row.checkedAt);
        return <span className="scr-mini">{age === null ? "—" : t(age.key, age.params)}</span>;
      },
      align: "right",
    },
    {
      key: "note",
      header: t("health.col.note"),
      cell: (row) => (
        <span className="scr-mini">
          {row.note === null ? "—" : label(row.note, "—")}
          {/* The wizard's pattern (Setup.tsx): a fault the operator cannot fix
              from THIS page is named and linked to the screen that fixes it.
              Only for connection-backed rows, and never over a green one. */}
          {CONNECTION_SERVICES.has(row.service) && row.state !== "healthy" && (
            <>
              {" · "}
              <Link to="/settings">{t("setup.prereq.open_settings")}</Link>
            </>
          )}
        </span>
      ),
    },
  ];

  return (
    <div className="scr-stack">
      <QueryState
        isPending={health.isPending}
        error={health.error}
        isEmpty={services.length === 0}
        emptyTitle={t("health.empty.services")}
        emptyIcon="💚"
        onRetry={() => void health.refetch()}
      >
        {health.data !== undefined && (
          <div className="scr-row">
            <Badge tone={STATE_TONE[health.data.state]} icon="●">
              {t(`health.overall.${health.data.state}`)}
            </Badge>
          </div>
        )}

        <Card title={t("health.card.services")} padded={false}>
          <Table
            columns={columns}
            rows={services}
            rowKey={(row) => row.service}
            emptyLabel={t("health.empty.services")}
            caption={t("health.card.services")}
          />
        </Card>
      </QueryState>
    </div>
  );
}
