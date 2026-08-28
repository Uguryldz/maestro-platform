import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Card, Kpi, Table } from "../ui/index.ts";
import type { BadgeTone, Column } from "../ui/index.ts";
import { type McpScope, type McpTool, type McpView } from "./common/index.ts";
import { useLabel } from "./common/label.ts";
import { MaybeUnwired } from "./shared/unwired.tsx";

const SCOPE_TONE: Readonly<Record<McpScope, BadgeTone>> = {
  read: "green",
  operate: "blue",
  "admin-proposal": "amber",
};

/**
 * Maestro's own MCP surface (M101): an AI assistant operating the platform with
 * the calling human's RBAC, never more.
 *
 * Two things must be legible here or the screen is misleading. First, scope:
 * `read` observes, `operate` acts on a flow, `admin-proposal` can only QUEUE a
 * change for a human to confirm — `propose_param_change` and
 * `propose_killswitch` are proposals, and the Studio side of that pair lives on
 * the params and settings screens. Second, and more important, the tools that
 * do NOT exist: `approve_gate`, `reject_gate`, `merge_pr`. Listing them as
 * absent is the point — an operator who cannot see the boundary assumes there
 * isn't one, and M32's "producer ≠ approver" would be a slogan rather than a
 * property of the system.
 */
export function McpScreen(): ReactNode {
  const api = useApi();
  const t = useT();
  const label = useLabel();

  const mcp = useQuery({
    queryKey: ["mcp"],
    queryFn: ({ signal }) => api.get<McpView>("/mcp/manifest", { signal }),
  });

  const columns: readonly Column<McpTool>[] = [
    {
      key: "name",
      header: t("mcp.col.tool"),
      cell: (row) => <code className="scr-mono">{row.name}</code>,
    },
    {
      key: "scope",
      header: t("mcp.col.scope"),
      cell: (row) => <Badge tone={SCOPE_TONE[row.scope]}>{t(`mcp.scope.${row.scope}`)}</Badge>,
    },
    {
      key: "what",
      header: t("mcp.col.what"),
      cell: (row) => <span className="scr-mini">{label(row.descriptionKey, row.name)}</span>,
    },
  ];

  const forbidden = mcp.data?.forbiddenTools ?? [];

  return (
    <div className="scr-stack">
      {/* `GET /mcp/manifest` is not built yet — see MaybeUnwired. */}
      <MaybeUnwired isPending={mcp.isPending} error={mcp.error} onRetry={() => void mcp.refetch()}>
        <div className="scr-grid scr-grid--4">
          <Kpi
            label={t("mcp.kpi.endpoint")}
            value={mcp.data?.endpoint ?? "—"}
            note={t("mcp.kpi.endpoint_note")}
          />
          <Kpi
            label={t("mcp.kpi.identity")}
            value={t("mcp.kpi.identity_value")}
            note={t("mcp.kpi.identity_note")}
          />
          <Kpi
            label={t("mcp.kpi.audit_actor")}
            value={mcp.data?.auditActor ?? "—"}
            note={t("mcp.kpi.audit_actor_note")}
          />
          <Kpi
            label={t("mcp.kpi.gate_decision")}
            value={t("mcp.kpi.gate_decision_value")}
            note={t("mcp.kpi.gate_decision_note")}
          />
        </div>

        <Card title={t("mcp.card.tools")} subtitle={t("mcp.card.tools_sub")} padded={false}>
          <Table
            columns={columns}
            rows={mcp.data?.tools ?? []}
            rowKey={(row) => row.name}
            emptyLabel={t("mcp.empty.tools")}
            caption={t("mcp.card.tools")}
          />
        </Card>

        <Card title={t("mcp.card.forbidden")} subtitle={t("mcp.card.forbidden_sub")}>
          {forbidden.length === 0 ? (
            <p className="scr-mini">{t("mcp.empty.forbidden")}</p>
          ) : (
            <div className="scr-row">
              {forbidden.map((tool) => (
                <Badge key={tool} tone="red" icon="⛔">
                  <code className="scr-mono">{tool}</code>
                </Badge>
              ))}
            </div>
          )}
          <div className="scr-note scr-note--warn" style={{ marginTop: 11 }}>
            {t("mcp.note.no_gate_decision")}
          </div>
        </Card>
      </MaybeUnwired>

      <Card title={t("mcp.card.connect")} subtitle={t("mcp.card.connect_sub")}>
        <p className="scr-mini">{t("mcp.connect.token_note")}</p>
      </Card>
    </div>
  );
}
