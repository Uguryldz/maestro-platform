import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { LlmCallLog, SubscriptionAccount } from "@maestro/contracts";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Card, Table } from "../ui/index.ts";
import { useEnumLabel } from "./common/label.ts";
import { QueryState } from "./shared/QueryState.tsx";
import { poolOutcome, outcomeExplanationKey, outcomeKey, outcomeTone } from "./shared/outcome.ts";

/**
 * Screen: llm — the LLM Gateway (M16/M55).
 *
 * All model traffic goes through one door: the subscription pool first, then
 * API drivers, then on-prem. When the pool is exhausted the run QUEUES rather
 * than failing, and that is the state this screen exists to make visible — a
 * pool at 100% is not an error, it is work parked until a window opens.
 *
 * The pool is shown as ACCOUNTS, not as a single average, because one exhausted
 * account among three ready ones is not a platform at 100%.
 */

/** `GET /studio/quota`. */
interface QuotaResponse {
  readonly accounts: readonly SubscriptionAccount[];
  readonly pool: {
    readonly ready: number;
    readonly cooling: number;
    readonly exhausted: number;
    readonly disabled: number;
    /** False when every account is spent — this is what makes a run queue. */
    readonly hasCapacity: boolean;
  };
}

/** `GET /studio/cost` — a page of gateway call log rows. */
interface CostPage {
  readonly items: readonly LlmCallLog[];
  readonly nextCursor: string | null;
}

const ACCOUNT_TONE = (state: string): "green" | "amber" | "red" | "gray" => {
  switch (state) {
    case "ready":
      return "green";
    case "cooling":
      return "amber";
    case "exhausted":
      return "red";
    default:
      return "gray";
  }
};

export function LlmScreen(): ReactNode {
  const t = useT();
  const api = useApi();
  const enumLabel = useEnumLabel();

  const quota = useQuery({
    queryKey: ["quota"],
    queryFn: ({ signal }) => api.get<QuotaResponse>("/studio/quota", { signal }),
  });

  const calls = useQuery({
    queryKey: ["cost", "calls"],
    queryFn: ({ signal }) => api.get<CostPage>("/studio/cost", { signal }),
  });

  const pool = quota.data?.pool;
  const outcome = poolOutcome(pool?.hasCapacity);

  return (
    <>
      <Card
        title={t("llm.pool")}
        subtitle={t("llm.pool_sub")}
        actions={
          pool === undefined ? undefined : (
            <Badge tone={outcomeTone(outcome)}>{t(outcomeKey(outcome))}</Badge>
          )
        }
        padded={false}
      >
        <QueryState
          isPending={quota.isPending}
          error={quota.error}
          isEmpty={(quota.data?.accounts ?? []).length === 0}
          emptyTitle={t("llm.no_accounts")}
          onRetry={() => void quota.refetch()}
        >
          <Table
            columns={[
              {
                key: "account",
                header: t("llm.col.account"),
                cell: (row: SubscriptionAccount) => row.accountId,
              },
              {
                key: "driver",
                header: t("llm.col.driver"),
                cell: (row) => <Badge tone="blue">{row.driver}</Badge>,
              },
              {
                key: "state",
                header: t("llm.col.state"),
                // ACCOUNT_TONE already falls through to grey for an unknown
                // state; the label needs the same treatment or the row throws.
                cell: (row) => (
                  <Badge tone={ACCOUNT_TONE(row.state)}>
                    {enumLabel("llm.account_state", row.state).text}
                  </Badge>
                ),
              },
              {
                key: "windows",
                header: t("llm.col.windows"),
                cell: (row) =>
                  row.windows
                    .map((w) => t("llm.window", { kind: w.kind, pct: String(Math.round(w.usedPct)) }))
                    .join(" · "),
              },
              {
                key: "resets",
                header: t("llm.col.resets"),
                cell: (row) => row.windows.map((w) => w.resetsAt).join(" · "),
              },
            ]}
            rows={quota.data?.accounts ?? []}
            rowKey={(row) => row.accountId}
            emptyLabel={t("llm.no_accounts")}
          />
        </QueryState>
      </Card>

      {pool !== undefined && (
        <p className="tpl-keyline" style={{ marginTop: 12 }}>
          {t("llm.pool_counts", {
            ready: String(pool.ready),
            cooling: String(pool.cooling),
            exhausted: String(pool.exhausted),
            disabled: String(pool.disabled),
          })}{" "}
          {t(outcomeExplanationKey(outcome))}
        </p>
      )}

      <div style={{ marginTop: 14 }}>
        <Card title={t("llm.calls")} subtitle={t("llm.calls_sub")} padded={false}>
          <QueryState
            isPending={calls.isPending}
            error={calls.error}
            isEmpty={(calls.data?.items ?? []).length === 0}
            emptyTitle={t("llm.no_calls")}
            onRetry={() => void calls.refetch()}
          >
            <Table
              columns={[
                { key: "at", header: t("llm.col.at"), cell: (row: LlmCallLog) => row.at },
                {
                  key: "role",
                  header: t("llm.col.role"),
                  cell: (row) => enumLabel("llm.role", row.role).text,
                },
                {
                  key: "driver",
                  header: t("llm.col.driver"),
                  cell: (row) => <Badge tone="blue">{row.driver}</Badge>,
                },
                { key: "model", header: t("llm.col.model"), cell: (row) => <code>{row.model}</code> },
                {
                  key: "tokens",
                  header: t("llm.col.tokens"),
                  cell: (row) => `${row.tokensIn} / ${row.tokensOut}`,
                  align: "right",
                },
                {
                  key: "cost",
                  header: t("llm.col.cost"),
                  // Subscription drivers have no dollar cost: the cost is quota.
                  // Rendering $0.00 there would misstate a real spend as free.
                  cell: (row) => (row.usd === null ? t("llm.cost_is_quota") : `$${row.usd.toFixed(2)}`),
                  align: "right",
                },
                {
                  key: "class",
                  header: t("llm.col.class"),
                  cell: (row) => (
                    <Badge tone={row.dataClass === "gizli" ? "red" : "gray"}>
                      {enumLabel("data_class", row.dataClass).text}
                    </Badge>
                  ),
                },
              ]}
              rows={calls.data?.items ?? []}
              rowKey={(row) => `${row.at}:${row.role}:${row.variantId}`}
              emptyLabel={t("llm.no_calls")}
            />
          </QueryState>
        </Card>
      </div>
    </>
  );
}
