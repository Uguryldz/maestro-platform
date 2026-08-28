import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Card, Input, Table } from "../ui/index.ts";
import { MaybeUnwired } from "./shared/unwired.tsx";
import { useEnumLabel } from "./common/label.ts";
import { bySeverity, severityTone, toSeverity } from "./shared/severity.ts";

/**
 * Screen: issues — the decision ledger (karar defteri).
 *
 * Every open question and its resolution, most-severe first, nothing hidden.
 * The filter box narrows what is shown, but the unfiltered total stays visible
 * so a narrow filter can never be mistaken for "there is nothing else".
 */

interface Decision {
  readonly decisionId: string;
  /** Masterplan reference, e.g. "M44". */
  readonly ref: string;
  readonly question: string;
  /** The audit action and who took it; the sentence is composed here. */
  readonly action: string;
  readonly actor: string;
  readonly severity: string;
  readonly status: string;
  readonly decidedAt: string;
}

export function IssuesScreen(): ReactNode {
  const t = useT();
  const api = useApi();
  const enumLabel = useEnumLabel();
  const [filter, setFilter] = useState("");

  const query = useQuery({
    queryKey: ["issues"],
    queryFn: ({ signal }) => api.get<{ decisions: readonly Decision[] }>("/decisions", { signal }),
  });

  const all = query.data?.decisions ?? [];
  const needle = filter.trim().toLowerCase();
  const matched =
    needle === ""
      ? all
      : all.filter(
          (d) =>
            // Matched against what the operator can SEE. Filtering on the raw
            // action while the column shows "Kapı onaya açıldı" would make a
            // search for the visible words return nothing; the raw enum is
            // still matched so an engineer's `GATE_OPEN` keeps working.
            enumLabel("audit.action", d.action).text.toLowerCase().includes(needle) ||
            d.action.toLowerCase().includes(needle) ||
            d.actor.toLowerCase().includes(needle) ||
            d.question.toLowerCase().includes(needle),
        );
  const rows = bySeverity(matched, (d) => d.severity);

  return (
    <>
      <Card
        title={t("issues.ledger")}
        subtitle={t("issues.counts", { shown: String(rows.length), total: String(all.length) })}
        actions={
          <Input
            label={t("issues.filter")}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        }
        padded={false}
      >
        <MaybeUnwired
          isPending={query.isPending}
          error={query.error}
          isEmpty={rows.length === 0}
          emptyTitle={needle === "" ? t("issues.empty") : t("issues.no_match")}
          onRetry={() => void query.refetch()}
        >
          <Table
            columns={[
              {
                key: "ref",
                header: t("issues.col.ref"),
                cell: (row: Decision) => {
                  const label = enumLabel("audit.action", row.ref);
                  return <Badge tone={label.unknown ? "gray" : "blue"}>{label.text}</Badge>;
                },
              },
              {
                key: "severity",
                header: t("issues.col.severity"),
                cell: (row) => (
                  <Badge tone={severityTone(row.severity)}>
                    {t(`severity.${toSeverity(row.severity)}`)}
                  </Badge>
                ),
              },
              { key: "question", header: t("issues.col.question"), cell: (row) => row.question },
              {
                key: "decision",
                header: t("issues.col.decision"),
                // Composed HERE, from two machine fields, rather than received
                // pre-joined: that is what let `GATE_OPEN · maestro-worker`
                // reach an auditor untranslated.
                cell: (row) =>
                  t("issues.decision_by", {
                    action: enumLabel("audit.action", row.action).text,
                    actor: row.actor,
                  }),
              },
              {
                key: "status",
                header: t("issues.col.status"),
                cell: (row) => enumLabel("issues.status", row.status).text,
              },
              { key: "at", header: t("issues.col.at"), cell: (row) => row.decidedAt },
            ]}
            rows={rows}
            rowKey={(row) => row.decisionId}
            emptyLabel={t("issues.empty")}
          />
        </MaybeUnwired>
      </Card>
    </>
  );
}
