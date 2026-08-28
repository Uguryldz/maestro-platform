import type { ParamChange, ParamDefinition } from "@maestro/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { messageKeyOf } from "../api/errors.ts";
import { useApi, useAuth } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Table, useToast } from "../ui/index.ts";
import type { Column } from "../ui/index.ts";
import {
  formatValue,
  type ParamPutResult,
  type ParamsView,
  type PendingParamChange,
  QueryState,
} from "./common/index.ts";
import { useLabel } from "./common/label.ts";
import { ParamEditor } from "./params/ParamEditor.tsx";

interface Row {
  readonly definition: ParamDefinition;
  readonly value: unknown;
  readonly version: number;
  readonly changedBy: string | null;
  readonly at: string | null;
  readonly pending: PendingParamChange | null;
}

/**
 * Operational parameters (M71): the gate sets, the SoD switches and the
 * escalation ladders live here rather than in five repositories' YAML.
 *
 * The screen's job beyond listing is to make four-eyes VISIBLE. A `guarded`
 * key carries a badge in the table, a warning in the editor and — once
 * proposed — a row that names the proposer and states the old value is still
 * the live one. The BFF is what enforces it (`putParam`); this is what stops an
 * operator believing a policy changed when it is only queued.
 */
export function ParamsScreen(): ReactNode {
  const api = useApi();
  const { session } = useAuth();
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const label = useLabel();
  const [editingKey, setEditingKey] = useState<string | null>(null);

  const params = useQuery({
    queryKey: ["params"],
    queryFn: ({ signal }) => api.get<ParamsView>("/params", { signal }),
  });

  const save = useMutation({
    mutationFn: (input: { key: string; value: unknown }) =>
      api.put<ParamPutResult>(`/params/${encodeURIComponent(input.key)}`, {
        value: input.value,
        scopeRef: null,
      }),
    onSuccess: (result, input) => {
      setEditingKey(null);
      void queryClient.invalidateQueries({ queryKey: ["params"] });
      toast.show(
        result.status === "applied" ? "success" : "warning",
        result.status === "applied"
          ? t("params.toast.applied", { key: input.key })
          : t("params.toast.pending", { key: input.key }),
      );
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const rows = useMemo<readonly Row[]>(() => buildRows(params.data), [params.data]);
  const editing = rows.find((row) => row.definition.key === editingKey) ?? null;

  const columns: readonly Column<Row>[] = [
    {
      key: "key",
      header: t("params.col.key"),
      cell: (row) => (
        <div>
          <code className="scr-mono">{row.definition.key}</code>
          {row.definition.guarded && (
            <>
              {" "}
              <Badge tone="amber">{t("params.badge.guarded")}</Badge>
            </>
          )}
          <div className="scr-mini">{label(row.definition.descriptionKey, row.definition.key)}</div>
        </div>
      ),
    },
    {
      key: "value",
      header: t("params.col.value"),
      cell: (row) => (
        <div>
          <span className="scr-mono">{formatValue(row.value)}</span>
          {row.pending !== null && (
            <div className="scr-mini">
              <Badge tone="orange">{t("params.badge.awaiting_approval")}</Badge>{" "}
              {t("params.pending.summary", {
                by: row.pending.proposedBy,
                value: formatValue(row.pending.value),
              })}
            </div>
          )}
        </div>
      ),
    },
    {
      key: "scope",
      header: t("params.col.scope"),
      cell: (row) => <Badge tone="gray">{t(`params.scope.${row.definition.scope}`)}</Badge>,
    },
    {
      key: "version",
      header: t("params.col.version"),
      cell: (row) => <span className="scr-mono">v{row.version}</span>,
      align: "right",
    },
    {
      key: "by",
      header: t("params.col.changed_by"),
      cell: (row) => <span className="scr-mini">{row.changedBy ?? t("params.value.default")}</span>,
    },
    {
      key: "edit",
      header: t("params.col.actions"),
      cell: (row) => (
        <Button size="sm" onClick={() => setEditingKey(row.definition.key)}>
          {row.definition.guarded ? t("params.action.review") : t("params.action.edit")}
        </Button>
      ),
    },
  ];

  return (
    <div className="scr-stack">
      <QueryState
        isPending={params.isPending}
        error={params.error}
        onRetry={() => void params.refetch()}
      >
        <Card
          title={t("params.card.list")}
          subtitle={t("params.card.list_sub")}
          padded={false}
        >
          <Table
            columns={columns}
            rows={rows}
            rowKey={(row) => row.definition.key}
            emptyLabel={t("params.empty")}
            caption={t("params.card.list")}
          />
        </Card>
      </QueryState>

      <div className="scr-note">{t("params.note.why_db")}</div>

      {editing !== null && (
        <ParamEditor
          definition={editing.definition}
          currentValue={editing.value}
          currentVersion={editing.version}
          pending={editing.pending}
          viewerUserId={session?.userId ?? null}
          busy={save.isPending}
          onClose={() => setEditingKey(null)}
          onSubmit={(value) => save.mutate({ key: editing.definition.key, value })}
        />
      )}
    </div>
  );
}

/**
 * `values` is an append-only history: one ParamChange per version. The current
 * value is the highest version for the key, and a definition with no change at
 * all is still shown — sitting on its default is a fact the operator needs, and
 * hiding unset parameters would make the list look shorter than the policy is.
 */
function buildRows(view: ParamsView | undefined): readonly Row[] {
  if (view === undefined) return [];

  const latest = new Map<string, ParamChange>();
  for (const change of view.values) {
    if (change.scopeRef !== null) continue;
    const current = latest.get(change.key);
    if (current === undefined || change.version > current.version) latest.set(change.key, change);
  }

  return view.definitions.map((definition) => {
    const change = latest.get(definition.key);
    const pending =
      view.pending.find((item) => item.key === definition.key && item.scopeRef === null) ?? null;
    return {
      definition,
      value: change?.value ?? definition.defaultValue,
      version: change?.version ?? 0,
      changedBy: change?.changedBy ?? null,
      at: change?.at ?? null,
      pending,
    };
  });
}
