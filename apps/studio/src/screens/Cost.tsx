import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { LlmCallLog, SubscriptionAccount } from "@maestro/contracts";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Card, Kpi, Table } from "../ui/index.ts";
import { useEnumLabel } from "./common/label.ts";
import { QueryState } from "./shared/QueryState.tsx";
import { poolOutcome, outcomeExplanationKey, outcomeKey, outcomeTone } from "./shared/outcome.ts";

/**
 * Screen: cost — spend and quota (M55/M16/M86).
 *
 * The single source of truth is the LLM Gateway call log. Subscription drivers
 * cost QUOTA and carry `usd: null`; API drivers cost DOLLARS. The two are
 * deliberately never summed into one number: adding a null-priced subscription
 * call into a dollar total would report the platform as cheaper than it is, and
 * a quota call is not free — it consumes a window that eventually queues work.
 *
 * Totals here are computed from the page the call log actually returned, and the
 * screen says so, rather than presenting a page total as an all-time figure.
 */

interface CostPage {
  readonly items: readonly LlmCallLog[];
  readonly nextCursor: string | null;
}

interface QuotaResponse {
  readonly accounts: readonly SubscriptionAccount[];
  readonly pool: {
    readonly ready: number;
    readonly cooling: number;
    readonly exhausted: number;
    readonly disabled: number;
    readonly hasCapacity: boolean;
  };
}

export function CostScreen(): ReactNode {
  const t = useT();
  const api = useApi();
  const enumLabel = useEnumLabel();

  const calls = useQuery({
    queryKey: ["cost", "calls"],
    queryFn: ({ signal }) => api.get<CostPage>("/studio/cost", { signal }),
  });

  const quota = useQuery({
    queryKey: ["quota"],
    queryFn: ({ signal }) => api.get<QuotaResponse>("/studio/quota", { signal }),
  });

  const items = calls.data?.items ?? [];
  // Dollars only from the rows that actually carry a price; quota-priced calls
  // are counted separately, never folded into the money figure.
  const apiCalls = items.filter((row) => row.usd !== null);
  const apiSpend = apiCalls.reduce((sum, row) => sum + (row.usd ?? 0), 0);
  const quotaCalls = items.length - apiCalls.length;
  const tokens = items.reduce((sum, row) => sum + row.tokensIn + row.tokensOut, 0);

  const pool = quota.data?.pool;
  const outcome = poolOutcome(pool?.hasCapacity);

  return (
    <>
      <Card title={t("cost.overview")} subtitle={t("cost.overview_sub")}>
        <QueryState
          isPending={calls.isPending}
          error={calls.error}
          onRetry={() => void calls.refetch()}
        >
          <div className="tpl-chips">
            <Kpi
              label={t("cost.api_spend")}
              value={`$${apiSpend.toFixed(2)}`}
              note={t("cost.api_spend_note", { n: String(apiCalls.length) })}
            />
            <Kpi
              label={t("cost.quota_calls")}
              value={String(quotaCalls)}
              note={t("cost.quota_calls_note")}
            />
            <Kpi label={t("cost.tokens")} value={tokens.toLocaleString()} />
          </div>
          <p className="tpl-keyline" style={{ marginTop: 12 }}>
            {t("cost.page_scope", { n: String(items.length) })}
          </p>
        </QueryState>
      </Card>

      <div style={{ marginTop: 14 }}>
        <Card title={t("cost.pool")} subtitle={t("cost.pool_sub")}>
          <QueryState
            isPending={quota.isPending}
            error={quota.error}
            onRetry={() => void quota.refetch()}
          >
            {pool !== undefined && (
              <>
                <p>
                  <Badge tone={outcomeTone(outcome)}>{t(outcomeKey(outcome))}</Badge>{" "}
                  {t(outcomeExplanationKey(outcome))}
                </p>
                <p className="tpl-keyline" style={{ marginTop: 8 }}>
                  {t("llm.pool_counts", {
                    ready: String(pool.ready),
                    cooling: String(pool.cooling),
                    exhausted: String(pool.exhausted),
                    disabled: String(pool.disabled),
                  })}
                </p>
              </>
            )}
          </QueryState>
        </Card>
      </div>

      <div style={{ marginTop: 14 }}>
        <Card title={t("cost.calls")} subtitle={t("cost.calls_sub")} padded={false}>
          <QueryState
            isPending={calls.isPending}
            error={calls.error}
            isEmpty={items.length === 0}
            emptyTitle={t("cost.no_calls")}
          >
            <Table
              columns={[
                { key: "at", header: t("llm.col.at"), cell: (row: LlmCallLog) => row.at },
                {
                  key: "ticket",
                  header: t("cost.col.run"),
                  // A call with no runId is platform overhead, not a run's cost.
                  cell: (row) => row.runId ?? t("cost.no_run"),
                },
                {
                  key: "role",
                  header: t("llm.col.role"),
                  // The gateway's role vocabulary grows independently of this
                  // build; an unrecognised one must not blank the cost table.
                  cell: (row) => enumLabel("llm.role", row.role).text,
                },
                {
                  key: "driver",
                  header: t("llm.col.driver"),
                  cell: (row) => <Badge tone="blue">{row.driver}</Badge>,
                },
                {
                  key: "tokens",
                  header: t("llm.col.tokens"),
                  cell: (row) => `${row.tokensIn} / ${row.tokensOut}`,
                  align: "right",
                },
                {
                  key: "usd",
                  header: t("llm.col.cost"),
                  cell: (row) => (row.usd === null ? t("llm.cost_is_quota") : `$${row.usd.toFixed(2)}`),
                  align: "right",
                },
                {
                  key: "class",
                  header: t("llm.col.class"),
                  // "gizli" stays red on the raw value, not on the label: the
                  // classification must keep its warning colour even if this
                  // build has no translation for some other class.
                  cell: (row) => (
                    <Badge tone={row.dataClass === "gizli" ? "red" : "gray"}>
                      {enumLabel("data_class", row.dataClass).text}
                    </Badge>
                  ),
                },
              ]}
              rows={items}
              rowKey={(row) => `${row.at}:${row.role}:${row.variantId}`}
              emptyLabel={t("cost.no_calls")}
            />
          </QueryState>
        </Card>
      </div>

      <p className="tpl-keyline" style={{ marginTop: 12 }}>
        {t("cost.visibility_note")}
      </p>
    </>
  );
}
