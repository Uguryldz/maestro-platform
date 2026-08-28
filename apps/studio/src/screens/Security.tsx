import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import type { ScanFinding } from "@maestro/contracts";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Card, Table } from "../ui/index.ts";
import { useEnumLabel } from "./common/label.ts";
import { MaybeUnwired } from "./shared/unwired.tsx";
import { bySeverity, severityTone, toSeverity } from "./shared/severity.ts";

/**
 * Screen: security — findings from the 6b scan stage (M27).
 *
 * Findings are shown most-severe first and none are hidden or collapsed by
 * default.
 *
 * The stage is fail-closed, and this screen preserves that: `outcome: "error"`
 * means the scanner could not run, which is NOT a clean result. It is rendered
 * in the same red register as a failure, never folded in with the passes,
 * because a scanner that never ran reporting as green is precisely the v1 bug
 * M27 exists to prevent.
 */

/** One row of `GET /studio/scans`. */
interface ScanRecord {
  readonly ticketKey: string;
  readonly finding: ScanFinding;
  readonly outcome: "pass" | "fail" | "error";
  readonly at: string;
}

interface ScanPage {
  readonly items: readonly ScanRecord[];
  readonly nextCursor: string | null;
}

const OUTCOME_TONE: Readonly<Record<string, "green" | "red" | "gray">> = {
  pass: "green",
  fail: "red",
  error: "red",
};

/**
 * `ScanFinding.message` in a deliberate container.
 *
 * This field is `NonEmpty` in the contract — free prose written by Semgrep,
 * Trivy or Gitleaks. Three separate problems with printing it bare, which the
 * previous `cell: (row) => row.finding.message` did:
 *
 *  1. It is not in the catalog. Every other sentence on this screen is Turkish
 *     from packages/config/locales; a scanner's English sentence beside them
 *     reads as if Maestro wrote it.
 *  2. A GITLEAKS finding's message can quote the leaked secret itself. The
 *     screen whose job is to report a leak must not become a second copy of it,
 *     rendered to anyone with a security role and captured in any screenshot of
 *     this page.
 *  3. Length is unbounded, so one finding could push a paragraph into a cell.
 *
 * The resolution is not to hide the text — an operator triaging a finding needs
 * it — but to make revealing it a decision. Collapsed by default with the tool
 * name visible, expanded on request, and labelled as untranslated scanner output
 * so nobody mistakes it for a platform message. A leaked secret then requires a
 * deliberate click rather than merely opening the screen.
 */
function FindingMessage({ finding }: { readonly finding: ScanFinding }): ReactNode {
  const t = useT();
  const [shown, setShown] = useState(false);

  if (!shown) {
    return (
      <button
        type="button"
        className="screen-chip"
        onClick={() => setShown(true)}
        title={t("value.raw_scanner_finding")}
      >
        {t("value.scanner_finding_show")}
      </button>
    );
  }

  return (
    <div>
      <span className="scr-mini">{t("value.raw_scanner_finding")}</span>
      {/*
        `lang` is set because the content is a foreign-language machine string
        inside a Turkish page: a screen reader must not read English prose with
        Turkish phonetics. `<samp>` marks it as program output rather than the
        page's own voice.
      */}
      <samp lang="en" style={{ display: "block", wordBreak: "break-word" }}>
        {finding.message}
      </samp>
    </div>
  );
}

export function SecurityScreen(): ReactNode {
  const t = useT();
  const api = useApi();
  const enumLabel = useEnumLabel();

  const query = useQuery({
    queryKey: ["scans"],
    queryFn: ({ signal }) => api.get<ScanPage>("/studio/scans", { signal }),
  });

  const rows = bySeverity(query.data?.items ?? [], (row) => row.finding.severity);
  const blocked = rows.filter((row) => row.outcome !== "pass").length;

  return (
    <>
      <Card
        title={t("security.findings")}
        subtitle={t("security.findings_sub")}
        actions={
          blocked > 0 ? (
            <Badge tone="red">{t("security.blocking_n", { n: String(blocked) })}</Badge>
          ) : undefined
        }
        padded={false}
      >
        <MaybeUnwired
          isPending={query.isPending}
          error={query.error}
          isEmpty={rows.length === 0}
          emptyTitle={t("security.no_findings")}
          onRetry={() => void query.refetch()}
        >
          <Table
            columns={[
              {
                key: "severity",
                header: t("security.col.severity"),
                cell: (row: ScanRecord) => (
                  <Badge tone={severityTone(row.finding.severity)}>
                    {t(`severity.${toSeverity(row.finding.severity)}`)}
                  </Badge>
                ),
              },
              { key: "ticket", header: t("security.col.ticket"), cell: (row) => row.ticketKey },
              {
                key: "tool",
                header: t("security.col.tool"),
                cell: (row) => <Badge tone="gray">{row.finding.tool}</Badge>,
              },
              {
                key: "finding",
                header: t("security.col.finding"),
                // Never `row.finding.message` bare — see FindingMessage.
                cell: (row) => <FindingMessage finding={row.finding} />,
              },
              {
                key: "location",
                header: t("security.col.location"),
                // file/line are optional in the contract: a secret found in git
                // history has no file to point at.
                cell: (row) =>
                  row.finding.file === undefined ? (
                    "—"
                  ) : (
                    <code>
                      {row.finding.file}
                      {row.finding.line === undefined ? "" : `:${row.finding.line}`}
                    </code>
                  ),
              },
              {
                key: "outcome",
                header: t("security.col.status"),
                // "error" is not a pass: a scanner that could not run must never
                // read as clean.
                cell: (row) => {
                  const label = enumLabel("security.outcome", row.outcome);
                  // An unrecognised outcome must never be toned green: "not a
                  // known result" is not "passed".
                  return (
                    <Badge tone={label.unknown ? "gray" : (OUTCOME_TONE[row.outcome] ?? "gray")}>
                      {label.text}
                    </Badge>
                  );
                },
              },
              { key: "at", header: t("security.col.at"), cell: (row) => row.at },
            ]}
            rows={rows}
            rowKey={(row) => `${row.ticketKey}:${row.finding.tool}:${row.finding.ruleId}:${row.at}`}
            emptyLabel={t("security.no_findings")}
          />
        </MaybeUnwired>
      </Card>

      <p className="tpl-keyline" style={{ marginTop: 12 }}>
        {t("security.fail_closed_note")}
      </p>
    </>
  );
}
