import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Card, Input, Table, riskTone } from "../ui/index.ts";
import type { Column } from "../ui/index.ts";
import { QueryState } from "./shared/QueryState.tsx";
import { ageLabel } from "./shared/format.ts";
import { useRuns, type RunRow } from "./shared/runs.ts";
import { RunStatusCell } from "./Tickets.tsx";
import "./shared/screens.css";

/**
 * Screen: fanout — a coordinator ticket and the child tickets its impact
 * matrix opened (M99/M100).
 *
 * This screen used to say, in as many words, that it did not know the tree:
 * the Temporal-backed `/runs` carried no parent link, so the honest fallback
 * was "sibling runs in the same Jira project", which is a different and weaker
 * claim. `GET /studio/runs` reads the platform catalog, and the catalog records
 * the link on both sides — `parentTicketKey` on the child, `childTicketKeys` on
 * the parent. So the tree below is READ, not inferred.
 *
 * Both directions are used on purpose. `childTicketKeys` is the parent's own
 * declaration and is therefore authoritative even for a child whose run has not
 * started; `parentTicketKey` finds children the parent has not (or no longer)
 * lists. A child named by the parent but absent from the page the operator can
 * see is shown as a key with no row rather than dropped — the alternative is a
 * tree that quietly under-reports its own scope.
 *
 * What is still missing is the impact matrix itself: it lives in the analysis
 * document and has no endpoint, so that card stays a stated gap.
 */

interface Tree {
  /** The parent's own row, when it is on the page the operator can see. */
  readonly parent: RunRow | null;
  /** Child rows, from both directions of the link, de-duplicated. */
  readonly children: readonly RunRow[];
  /** Keys the parent claims as children but which no visible row matches. */
  readonly missing: readonly string[];
}

function treeOf(runs: readonly RunRow[], parentKey: string): Tree {
  const parent = runs.find((run) => run.ticketKey === parentKey) ?? null;
  const claimed = new Set<string>(parent?.childTicketKeys ?? []);

  const children = runs.filter(
    (run) => run.ticketKey !== parentKey && (run.parentTicketKey === parentKey || claimed.has(run.ticketKey)),
  );

  const present = new Set(children.map((run) => run.ticketKey));
  return {
    parent,
    children,
    missing: [...claimed].filter((key) => !present.has(key)),
  };
}

export function FanoutScreen(): ReactNode {
  const t = useT();
  const navigate = useNavigate();
  const [parent, setParent] = useState("");

  const { data, isPending, error, refetch } = useRuns(200);
  const runs = useMemo(() => data?.runs ?? [], [data]);

  const key = parent.trim();
  const tree = useMemo(() => (key === "" ? null : treeOf(runs, key)), [runs, key]);

  const columns: readonly Column<RunRow>[] = [
    {
      key: "ticket",
      header: t("col.ticket"),
      cell: (run) => (
        <>
          <b className="screen-mono">{run.ticketKey}</b>
          <div className="screen-note">{run.title}</div>
        </>
      ),
    },
    {
      key: "app",
      // Per M100 a child's application is written FROM the analysis, so this
      // column is the fan-out's actual output: which systems the work reaches.
      header: t("col.app"),
      cell: (run) => (run.appId === null ? "—" : <span className="screen-mono">{run.appId}</span>),
    },
    {
      key: "status",
      header: t("col.status"),
      cell: (run) => <RunStatusCell status={run.status} />,
    },
    {
      key: "risk",
      header: t("col.risk"),
      cell: (run) => <Badge tone={riskTone(run.risk)}>{t(`risk.${run.risk}`)}</Badge>,
    },
    {
      key: "age",
      header: t("col.age"),
      align: "right",
      cell: (run) => {
        const age = ageLabel(run.startedAt);
        return age === null ? "—" : t(age.key, age.params);
      },
    },
  ];

  return (
    <div className="screen-stack">
      <Card title={t("fanout.pick.title")} subtitle={t("fanout.pick.subtitle")}>
        <Input
          label={t("fanout.field.parent")}
          value={parent}
          onChange={(event) => setParent(event.target.value)}
          hint={t("fanout.field.parent_hint")}
        />
      </Card>

      {tree?.parent != null && (
        <Card title={t("fanout.parent.title")}>
          <dl className="screen-kv">
            <dt>{t("col.ticket")}</dt>
            <dd className="screen-mono">{tree.parent.ticketKey}</dd>
            <dt>{t("fanout.parent.subject")}</dt>
            <dd>{tree.parent.title}</dd>
            <dt>{t("col.status")}</dt>
            <dd>
              <RunStatusCell status={tree.parent.status} />
            </dd>
            <dt>{t("fanout.parent.children")}</dt>
            <dd>{String(tree.parent.childTicketKeys.length)}</dd>
          </dl>
        </Card>
      )}

      <Card title={t("fanout.matrix.title")}>
        <p className="screen-note">{t("fanout.matrix.unavailable")}</p>
      </Card>

      <Card
        title={t("fanout.children.title")}
        subtitle={key === "" ? t("fanout.siblings.none") : key}
        padded={false}
      >
        <QueryState isPending={isPending} error={error} onRetry={() => void refetch()} skeletonRows={4}>
          <Table
            columns={columns}
            rows={tree?.children ?? []}
            rowKey={(run) => run.ticketKey}
            emptyLabel={key === "" ? t("fanout.siblings.prompt") : t("fanout.children.empty")}
            caption={t("fanout.children.caption")}
            onRowClick={(run) => void navigate(`/detail/${run.ticketKey}`)}
          />
        </QueryState>
      </Card>

      {tree !== null && tree.missing.length > 0 && (
        <Card title={t("fanout.missing.title")}>
          <p className="screen-note">{t("fanout.missing.body")}</p>
          <ul className="screen-kv">
            {tree.missing.map((child) => (
              <li key={child} className="screen-mono">
                {child}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title={t("fanout.rules.title")}>
        <dl className="screen-kv">
          <dt>{t("fanout.rules.assignment")}</dt>
          <dd>{t("fanout.rules.assignment_value")}</dd>
          <dt>{t("fanout.rules.closure")}</dt>
          <dd>{t("fanout.rules.closure_value")}</dd>
          <dt>{t("fanout.rules.evidence")}</dt>
          <dd>{t("fanout.rules.evidence_value")}</dd>
        </dl>
      </Card>
    </div>
  );
}
