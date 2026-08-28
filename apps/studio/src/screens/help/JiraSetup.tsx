import type { ReactNode } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../auth/AuthProvider.tsx";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Card, Table, type Column } from "../../ui/index.ts";
import { englishAside } from "../common/jira-english.ts";
import "../shared/screens.css";

/**
 * "Jira'da ne yapmam gerekiyor?" — the one question no screen answered.
 *
 * An operator could read the whole guide and still not know how to make a
 * ticket reach Maestro, because the trigger lives in the `ListeningRule` table
 * and was never surfaced. This card answers it from THAT table
 * (`GET /studio/listening-rules`), so when an admin edits a rule the
 * instructions change with it. Nothing here is hard-coded: with no rules the
 * card says so plainly rather than printing an invented project key.
 *
 * PII: a rule identifies the bot by `assigneeAccountId`. The account id is what
 * the operator needs (it is what Jira's assignee picker resolves to) and it is
 * an opaque identifier, not personal data — the bot's e-mail is deliberately
 * NOT shown, and no endpoint here returns one.
 */

interface ListeningRuleWire {
  readonly ruleId: string;
  readonly projectKey: string;
  readonly assigneeAccountId: string;
  readonly matchKind: string;
  readonly matchValue: string;
  readonly flowType: string;
  readonly enabled: boolean;
}

/**
 * The webhook PATH Jira must call. Deliberately not a full URL.
 *
 * The browser only knows the origin it loaded Studio from, and that is the
 * wrong answer: in development it is the Vite dev server, and in a real
 * deployment Studio and the BFF are usually served from different hosts. Jira
 * has to reach the BFF, so printing `location.origin` here would hand the
 * operator a URL that silently never fires. The path is the part Maestro
 * actually knows (`apps/bff/src/routes/webhooks.ts`); the host is the
 * deployment's own fact, so the operator supplies it.
 */
const WEBHOOK_PATH = "/webhooks/jira";

export function JiraSetupCard(): ReactNode {
  const t = useT();
  const api = useApi();

  const rules = useQuery({
    queryKey: ["listening-rules"],
    queryFn: ({ signal }) =>
      api.get<{ rules: readonly ListeningRuleWire[] }>("/studio/listening-rules", { signal }),
    retry: false,
  });

  const active = (rules.data?.rules ?? []).filter((r) => r.enabled);

  const columns: readonly Column<ListeningRuleWire>[] = [
    {
      key: "projectKey",
      header: t("help.jira.col.project"),
      cell: (r) => <b className="screen-mono">{r.projectKey}</b>,
    },
    {
      key: "matchValue",
      header: t("help.jira.col.match"),
      // This is instructions, so the English aside earns its place here most of
      // all: the reader is about to go to Jira and set this field, and half of
      // them are looking at a Jira UI in English. The value stays the stored
      // Turkish one — it is what the rule matches, and it is what the operator
      // has to make the ticket say.
      cell: (r) => {
        // A catch-all names no field, so there is nothing to go and set: the
        // instruction is "assign it to the bot", which the next column says.
        if (r.matchKind === "assigned") {
          return <b>{t("help.jira.match.assigned")}</b>;
        }
        const english = englishAside(r.matchValue);
        return (
          <span>
            <span className="screen-note">{t(`help.jira.match.${r.matchKind}`)}: </span>
            <b>{r.matchValue}</b>
            {english !== null && (
              <span className="screen-note"> {t("jira.english.aside", { english })}</span>
            )}
          </span>
        );
      },
    },
    {
      key: "assigneeAccountId",
      header: t("help.jira.col.assignee"),
      cell: (r) => <span className="screen-mono">{r.assigneeAccountId}</span>,
    },
    {
      key: "flowType",
      header: t("help.jira.col.flow"),
      cell: (r) => <span>{r.flowType}</span>,
    },
  ];

  return (
    <Card title={t("help.jira.title")} subtitle={t("help.jira.sub")}>
      <div className="help-guide">
        <section className="help-guide__block">
          <h4 className="help-guide__h">{t("help.jira.open.title")}</h4>
          {rules.isPending ? (
            <p className="scr-prose">{t("help.jira.loading")}</p>
          ) : active.length === 0 ? (
            // No rule → no trigger. Say exactly that; never invent an example.
            <p className="scr-prose">{t("help.jira.no_rules")}</p>
          ) : (
            <>
              <p className="scr-prose">{t("help.jira.open.body")}</p>
              <Table
                columns={columns}
                rows={active}
                rowKey={(r) => r.ruleId}
                emptyLabel={t("help.jira.no_rules")}
              />
              <p className="screen-note">{t("help.jira.open.note")}</p>
            </>
          )}
        </section>

        <section className="help-guide__block">
          <h4 className="help-guide__h">{t("help.jira.webhook.title")}</h4>
          <p className="scr-prose">{t("help.jira.webhook.body")}</p>
          <ul className="help-fields">
            <li>
              <b>{t("help.jira.webhook.url_label")}</b>{" "}
              <span className="screen-mono">{t("help.jira.webhook.url_host")}{WEBHOOK_PATH}</span>{" "}
              <span className="screen-note">{t("help.jira.webhook.url_note")}</span>
            </li>
            <li>
              <b>{t("help.jira.webhook.events_label")}</b> {t("help.jira.webhook.events")}
            </li>
            <li>
              <b>{t("help.jira.webhook.secret_label")}</b> {t("help.jira.webhook.secret")}
            </li>
          </ul>
        </section>

        <section className="help-guide__block">
          <h4 className="help-guide__h">{t("help.jira.perms.title")}</h4>
          <p className="scr-prose">{t("help.setup_step.permissions")}</p>
        </section>

        <section className="help-guide__block help-guide__block--example">
          <h4 className="help-guide__h">{t("help.jira.approve.title")}</h4>
          <p className="scr-prose">{t("help.jira.approve.body")}</p>
        </section>
      </div>
      <p style={{ marginTop: 10 }}>
        <Link to="/projects?tab=listening">{t("help.jira.goto_rules")}</Link>
      </p>
    </Card>
  );
}
