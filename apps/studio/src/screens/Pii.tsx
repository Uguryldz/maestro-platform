import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Card, Kpi, Table } from "../ui/index.ts";
import { useEnumLabel } from "./common/label.ts";
import { MaybeUnwired } from "./shared/unwired.tsx";

/**
 * Screen: pii — PII masking overview.
 *
 * SECURITY, NON-NEGOTIABLE: masking happens on the SERVER. This screen can
 * neither unmask nor request an unmasked value, and it must never render a
 * masked value's plaintext. It reports WHAT was masked as COUNTS and by RULE
 * only.
 *
 * The v1 audit finding was exactly this shape: an unmasked "second copy" of the
 * value was kept for display. So the response type below deliberately has no
 * field that could carry a sample value, and no sample is requested. If a
 * future BFF version starts returning one, this screen still cannot show it —
 * add nothing here.
 */

interface PiiRule {
  readonly ruleId: string;
  /** "field" | "regex" — what the rule matches on. */
  readonly kind: string;
  /** The field name or pattern being matched. NOT a value. */
  readonly matcher: string;
  /** "hash" | "redact" | "partial" */
  readonly strategy: string;
  /** How many times this rule fired in the window. A count, never a value. */
  readonly hits: number;
}

interface PiiSummary {
  readonly maskedCalls: number;
  readonly totalCalls: number;
  readonly maskedFields: number;
  /** Variants exempted from masking; an exemption is a risk, so it is shown. */
  readonly exemptVariants: readonly string[];
  /** Calls that went to an on-prem model unmasked because they never leave. */
  readonly onPremCalls: number;
  /** Whether the archive stores the masked form (must be true). */
  readonly archiveMasked: boolean;
}

interface PiiResponse {
  readonly summary: PiiSummary;
  readonly rules: readonly PiiRule[];
}

export function PiiScreen(): ReactNode {
  const t = useT();
  const api = useApi();
  const enumLabel = useEnumLabel();

  const query = useQuery({
    queryKey: ["pii"],
    queryFn: ({ signal }) => api.get<PiiResponse>("/pii", { signal }),
  });

  const summary = query.data?.summary;
  const pct =
    summary !== undefined && summary.totalCalls > 0
      ? Math.round((summary.maskedCalls / summary.totalCalls) * 100)
      : 0;

  return (
    <>
      <Card title={t("pii.today")}>
        <MaybeUnwired isPending={query.isPending} error={query.error} onRetry={() => void query.refetch()}>
          {summary !== undefined && (
            <>
              <div className="tpl-chips">
                <Kpi
                  label={t("pii.masked_calls")}
                  value={`${summary.maskedCalls} / ${summary.totalCalls}`}
                  note={t("pii.masked_pct", { pct: String(pct) })}
                />
                <Kpi label={t("pii.masked_fields")} value={String(summary.maskedFields)} />
                <Kpi
                  label={t("pii.onprem_calls")}
                  value={String(summary.onPremCalls)}
                  note={t("pii.onprem_note")}
                />
                <Kpi
                  label={t("pii.exempt_variants")}
                  value={String(summary.exemptVariants.length)}
                  note={
                    summary.exemptVariants.length === 0
                      ? t("pii.exempt_none")
                      : summary.exemptVariants.join(", ")
                  }
                />
              </div>
              <p className="tpl-keyline" style={{ marginTop: 12 }}>
                <Badge tone={summary.archiveMasked ? "green" : "red"}>
                  {summary.archiveMasked ? t("pii.archive_masked") : t("pii.archive_unmasked")}
                </Badge>{" "}
                {t("pii.archive_note")}
              </p>
            </>
          )}
        </MaybeUnwired>
      </Card>

      <div style={{ marginTop: 14 }}>
        <Card title={t("pii.rules")} subtitle={t("pii.rules_sub")} padded={false}>
          <MaybeUnwired
            isPending={query.isPending}
            error={query.error}
            isEmpty={(query.data?.rules ?? []).length === 0}
            emptyTitle={t("pii.no_rules")}
          >
            <Table
              columns={[
                {
                  key: "kind",
                  header: t("pii.col.kind"),
                  cell: (row: PiiRule) => (
                    <Badge tone="gray">{enumLabel("pii.kind", row.kind).text}</Badge>
                  ),
                },
                { key: "matcher", header: t("pii.col.matcher"), cell: (row) => <code>{row.matcher}</code> },
                {
                  key: "strategy",
                  header: t("pii.col.strategy"),
                  cell: (row) => {
                    const label = enumLabel("pii.strategy", row.strategy);
                    return <Badge tone={label.unknown ? "gray" : "purple"}>{label.text}</Badge>;
                  },
                },
                {
                  key: "hits",
                  header: t("pii.col.hits"),
                  cell: (row) => String(row.hits),
                  align: "right",
                },
              ]}
              rows={query.data?.rules ?? []}
              rowKey={(row) => row.ruleId}
              emptyLabel={t("pii.no_rules")}
            />
          </MaybeUnwired>
        </Card>
      </div>

      <p className="tpl-keyline" style={{ marginTop: 12 }}>
        {t("pii.no_unmask_note")}
      </p>
    </>
  );
}
