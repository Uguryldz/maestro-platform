import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Card, Table } from "../ui/index.ts";
import type { Column } from "../ui/index.ts";
import { type CommandsView, type JiraCommand } from "./common/index.ts";
import { useEnumLabel, useLabel } from "./common/label.ts";
import { MaybeUnwired } from "./shared/unwired.tsx";

/** The checks a comment passes before it counts as a decision. */
const VALIDATION_STEPS = [
  "commands.check.recognised",
  "commands.check.no_extra_text",
  "commands.check.no_edit",
  "commands.check.authorised",
  "commands.check.right_step",
  "commands.check.sod",
  "commands.check.idempotent",
] as const;

/**
 * The Jira command set: what a developer can type in a ticket comment, who may
 * type it, and what happens.
 *
 * The validation ladder beneath the table is not decoration. Two of its rungs
 * are security properties that are easy to lose: a comment containing anything
 * besides the bare command is NOT an approval (Turkish puts the negation at the
 * end, so "/approve etmiyorum" would otherwise read as consent), and EDITING a
 * comment never produces one — otherwise an approval could be back-dated into a
 * thread after the fact, and M32's signature would mean nothing.
 */
export function CommandsScreen(): ReactNode {
  const api = useApi();
  const t = useT();
  const label = useLabel();
  const enumLabel = useEnumLabel();

  const commands = useQuery({
    queryKey: ["commands"],
    queryFn: ({ signal }) => api.get<CommandsView>("/commands", { signal }),
  });

  const columns: readonly Column<JiraCommand>[] = [
    {
      key: "name",
      header: t("commands.col.command"),
      cell: (row) => (
        <code className="scr-mono">
          {row.name}
          {row.takesArgument && ` ${t("commands.argument_placeholder")}`}
        </code>
      ),
    },
    {
      key: "who",
      header: t("commands.col.who"),
      cell: (row) => (
        <span className="scr-row">
          {row.roles.length === 0 ? (
            <Badge tone="gray">{t("commands.who.anyone")}</Badge>
          ) : (
            row.roles.map((role) => {
              const roleLabel = enumLabel("role", role);
              return (
                <Badge key={role} tone={roleLabel.unknown ? "gray" : "blue"}>
                  {roleLabel.text}
                </Badge>
              );
            })
          )}
        </span>
      ),
    },
    {
      key: "when",
      header: t("commands.col.when"),
      cell: (row) => <span className="scr-mini">{label(row.whenKey, "—")}</span>,
    },
    {
      key: "effect",
      header: t("commands.col.effect"),
      cell: (row) => <span className="scr-mini">{label(row.effectKey, "—")}</span>,
    },
  ];

  return (
    <div className="scr-stack">
      {/* `GET /commands` is not built yet — see MaybeUnwired. */}
      <MaybeUnwired
        isPending={commands.isPending}
        error={commands.error}
        onRetry={() => void commands.refetch()}
      >
        <Card title={t("commands.card.list")} subtitle={t("commands.card.list_sub")} padded={false}>
          <Table
            columns={columns}
            rows={commands.data?.commands ?? []}
            rowKey={(row) => row.name}
            emptyLabel={t("commands.empty")}
            caption={t("commands.card.list")}
          />
        </Card>
      </MaybeUnwired>

      <Card title={t("commands.card.validation")} subtitle={t("commands.card.validation_sub")}>
        <ol className="scr-stack" style={{ gap: 7, margin: 0, paddingLeft: 18 }}>
          {VALIDATION_STEPS.map((step) => (
            <li key={step} className="scr-prose" style={{ margin: 0 }}>
              {t(step)}
            </li>
          ))}
        </ol>
        <div className="scr-note scr-note--warn" style={{ marginTop: 12 }}>
          {t("commands.note.exact_match")}
        </div>
      </Card>
    </div>
  );
}
