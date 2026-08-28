import type { ReactNode } from "react";
import { Link } from "react-router";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Card, Table } from "../ui/index.ts";
import type { Column } from "../ui/index.ts";
import "./shared/screens.css";

/**
 * Screen: jira — how Maestro appears inside Jira, where ~90% of users meet it.
 *
 * This screen is reference documentation, and it is static on purpose: the
 * command set, who may run each command and what each one does are product
 * rules, not server state. There is nothing to fetch, so there is no request,
 * no spinner and no fake latency.
 *
 * The mock also renders a sample comment thread and a live command box. Both
 * are omitted: a transcript hard-coded into the client would be indistinguishable
 * from a real one on screen, and an input that "executes" a command without
 * reaching a workflow would teach the operator a behaviour the product does not
 * have. Real gate decisions live on the detail screen, over the signal endpoint.
 */

interface CommandRow {
  readonly id: string;
  readonly command: string;
  /** Catalog key for who may use it. */
  readonly whoKey: string;
  /** Catalog key for when it applies. */
  readonly whenKey: string;
  /** Catalog key for what it does. */
  readonly effectKey: string;
  readonly tone: "green" | "amber" | "blue";
}

/** Mirrors the mock's command table; wording lives in the catalog. */
const COMMANDS: readonly CommandRow[] = [
  { id: "approve", command: "/approve", whoKey: "jira.who.gate_owner", whenKey: "jira.when.human_gates", effectKey: "jira.effect.approve", tone: "green" },
  { id: "reject", command: "/reject <sebep>", whoKey: "jira.who.gate_owner", whenKey: "jira.when.human_gates", effectKey: "jira.effect.reject", tone: "amber" },
  { id: "status", command: "/status", whoKey: "jira.who.anyone", whenKey: "jira.when.always", effectKey: "jira.effect.status", tone: "blue" },
  { id: "cancel", command: "/cancel", whoKey: "jira.who.po_tl", whenKey: "jira.when.always", effectKey: "jira.effect.cancel", tone: "amber" },
  { id: "retry", command: "/retry", whoKey: "jira.who.tl", whenKey: "jira.when.on_failure", effectKey: "jira.effect.retry", tone: "blue" },
  { id: "mode_change", command: "/mode-change <mod>", whoKey: "jira.who.tl", whenKey: "jira.when.always", effectKey: "jira.effect.mode_change", tone: "blue" },
  { id: "ai_takeover", command: "/ai-takeover", whoKey: "jira.who.dev", whenKey: "jira.when.engineering", effectKey: "jira.effect.ai_takeover", tone: "blue" },
  { id: "ai_handoff", command: "/ai-handoff", whoKey: "jira.who.dev_or_ai", whenKey: "jira.when.engineering", effectKey: "jira.effect.ai_handoff", tone: "blue" },
  { id: "ai_assign", command: "/ai-assign <uygulama>", whoKey: "jira.who.dev", whenKey: "jira.when.unmatched", effectKey: "jira.effect.ai_assign", tone: "blue" },
  { id: "ai_explain", command: "/ai-explain", whoKey: "jira.who.anyone", whenKey: "jira.when.after_engineering", effectKey: "jira.effect.ai_explain", tone: "blue" },
  { id: "ai_start", command: "/ai-start", whoKey: "jira.who.dev", whenKey: "jira.when.opt_in", effectKey: "jira.effect.ai_start", tone: "green" },
];

/** The validation chain every comment command passes through. */
const CHECKS = ["recognised", "no_extra_text", "edit_not_command", "authorised", "right_step", "sod", "idempotent"] as const;

export function JiraScreen(): ReactNode {
  const t = useT();

  const columns: readonly Column<CommandRow>[] = [
    {
      key: "command",
      header: t("jira.col.command"),
      cell: (row) => <code className="screen-mono">{row.command}</code>,
    },
    { key: "who", header: t("jira.col.who"), cell: (row) => <span className="screen-note">{t(row.whoKey)}</span> },
    { key: "when", header: t("jira.col.when"), cell: (row) => <span className="screen-note">{t(row.whenKey)}</span> },
    { key: "effect", header: t("jira.col.effect"), cell: (row) => t(row.effectKey) },
  ];

  return (
    <div className="screen-stack">
      <Card title={t("jira.intro.title")}>
        <p className="screen-note">{t("jira.intro.body")}</p>
      </Card>

      <Card title={t("jira.commands.title")} subtitle={t("jira.commands.subtitle")} padded={false}>
        <Table
          columns={columns}
          rows={COMMANDS}
          rowKey={(row) => row.id}
          emptyLabel={t("empty.no_data")}
          caption={t("jira.commands.caption")}
        />
      </Card>

      <div className="screen-grid screen-grid--2">
        <Card title={t("jira.checks.title")} subtitle={t("jira.checks.subtitle")}>
          <ol className="screen-stack" style={{ margin: 0, paddingInlineStart: 20 }}>
            {CHECKS.map((check) => (
              <li key={check} style={{ fontSize: 13 }}>
                {t(`jira.check.${check}`)}
              </li>
            ))}
          </ol>
        </Card>

        <Card title={t("jira.boundaries.title")}>
          <dl className="screen-kv">
            <dt>{t("jira.boundary.workflow")}</dt>
            <dd>{t("jira.boundary.workflow_value")}</dd>
            <dt>{t("jira.boundary.authority")}</dt>
            <dd>{t("jira.boundary.authority_value")}</dd>
            <dt>{t("jira.boundary.progress")}</dt>
            <dd>{t("jira.boundary.progress_value")}</dd>
          </dl>
          <p className="screen-note">
            <Badge tone="amber">{t("jira.boundary.badge")}</Badge> {t("jira.boundary.note")}
          </p>
          <div className="screen-actions">
            <Link className="ui-btn ui-btn--sm" to="/tickets">
              {t("jira.action.tickets")}
            </Link>
          </div>
        </Card>
      </div>
    </div>
  );
}
