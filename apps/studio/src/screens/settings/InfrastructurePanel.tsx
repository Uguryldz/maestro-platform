import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useApi } from "../../auth/AuthProvider.tsx";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Badge, Card, Table } from "../../ui/index.ts";
import type { BadgeTone, Column } from "../../ui/index.ts";
import type { Connection, SettingsView } from "../common/index.ts";
import { QueryState, useLabel } from "../common/index.ts";
import { ageLabel } from "../shared/format.ts";

/**
 * The read-only INFRASTRUCTURE section of the settings screen — what this
 * deployment actually runs on: the workflow engine, the database, the LLM
 * endpoint, and the ports that are (or are not) wired.
 *
 * Why this sits beside {@link ConnectorsPanel} rather than merged into it. The
 * screen once carried a read-only "deployment facts" table and it was removed
 * for a good reason: back then the list carried only jira/ado/vault-shaped
 * rows, which genuinely restated the editable panel under the same heading.
 * That reason expired. The list now also carries `temporal`, `database` and
 * `llm` — the engine the platform RUNS ON — and none of those appear in the
 * editable panel at all, so "where is the engine pointed, is it up?" had no
 * screen to be asked from.
 *
 * The overlap is not resolved by hiding rows. A row here and a row there can
 * carry the SAME id and DIFFERENT truth: `/studio/connections` `jira` is a site
 * an operator typed into Studio, while `jira` here is the site `deploy/.env`
 * wired into the running process. When those two disagree, the disagreement is
 * the single most useful thing this screen can show, and a de-duplicating
 * filter would delete precisely that. So both tables render in full and the
 * DIFFERENCE is stated in the card's own subtitle: one is what the operator
 * manages, this one is what the deployment is, and it is not editable from
 * here.
 *
 * Nothing in this panel writes. There is no edit, no delete, no test button —
 * these values come from the environment file the platform booted with, and a
 * control implying otherwise would be a lie about where the authority lives.
 */
export function InfrastructurePanel(): ReactNode {
  const api = useApi();
  const t = useT();
  const label = useLabel();

  const query = useQuery({
    queryKey: ["settings", "infrastructure"],
    queryFn: ({ signal }) => api.get<SettingsView>("/settings", { signal }),
  });

  const columns: readonly Column<Connection>[] = [
    {
      key: "name",
      header: t("settings.col.connection"),
      // The catalog knows the eleven ids the BFF reports; an id it has not
      // heard of shows raw rather than blanking the table behind the
      // ErrorBoundary — a new component is exactly what an operator must see.
      cell: (row) => <b>{label(`settings.connection.${row.id}`, row.id)}</b>,
    },
    {
      key: "status",
      header: t("settings.col.status"),
      cell: (row) => <StatusCell row={row} />,
    },
    {
      key: "endpoint",
      header: t("settings.col.target"),
      // Rendered EXACTLY as the server sent it. `database` arrives already
      // masked (`postgresql://maestro:***@host`); masking it a second time here
      // would hide whether the server did its job, and a screen that cannot
      // show a leak cannot report one either.
      cell: (row) =>
        row.endpoint === "" ? (
          <span className="scr-mini">{t("settings.infra.endpoint_unset")}</span>
        ) : (
          <span className="scr-mono scr-mini">{row.endpoint}</span>
        ),
    },
    {
      key: "credential",
      header: t("settings.col.credential"),
      // A POINTER into the secret store (`vault:maestro/jira#token`), never the
      // secret. The value it names never leaves the process that resolves it.
      cell: (row) => <span className="scr-mono scr-mini">{row.credentialRef}</span>,
    },
  ];

  return (
    <Card
      title={t("settings.infra.title")}
      subtitle={t("settings.infra.sub")}
      padded={false}
    >
      <QueryState
        isPending={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        skeletonRows={4}
      >
        <Table
          columns={columns}
          rows={query.data?.connections ?? []}
          rowKey={(row) => row.id}
          emptyLabel={t("settings.empty.connections")}
          caption={t("settings.infra.title")}
        />
      </QueryState>
    </Card>
  );
}

/**
 * The status cell — three states the operator must be able to tell apart.
 *
 * The endpoint reports `connected` in two materially different situations, and
 * collapsing them would be the expensive kind of wrong. `temporal` and
 * `database` are `connected` because a probe REACHED them and stamped
 * `checkedAt`. `jira`, `llm` and `identity` are `connected` only because an
 * address is configured — no probe exists for them, so `checkedAt` is null and
 * nobody has actually knocked on the door.
 *
 * A green "connected" light burning over an engine nobody checked is the most
 * expensive thing this screen could say, so an unprobed row is rendered as
 * "configured" in a neutral tone, with a plain statement that it was not
 * probed. That is a presentation decision made from `status` + `checkedAt`,
 * both of which the endpoint already sends; no status is invented, and the
 * BFF's own vocabulary is left untouched.
 */
function StatusCell({ row }: { readonly row: Connection }): ReactNode {
  const t = useT();
  const probed = row.checkedAt !== null;
  const { tone, icon, key } = infraStatusOf(row.status, probed);
  const age = probed ? ageLabel(row.checkedAt) : null;

  return (
    <div>
      <Badge tone={tone} icon={icon}>
        {t(key)}
      </Badge>
      <div className="scr-mini" style={{ marginTop: 3 }}>
        <span>{probedNote(t, age)}</span>
      </div>
    </div>
  );
}

/**
 * The line under the badge: when the probe last ran, or that it never did.
 *
 * Why this is not one template with an `{age}` hole. `age.*` is not a uniform
 * family: `age.days`/`age.hours`/`age.minutes` are bare durations ("5 gün",
 * "5d") that need a preposition around them, but `age.now` is already a
 * complete adverbial phrase ("az önce", "just now"). Feeding it to the same
 * "{age} önce yoklandı" template produced "az önce ÖNCE yoklandı" on the live
 * screen — and "probed just now ago" in English. So the just-probed case gets
 * its own sentence, chosen by which key `ageLabel` returned rather than by
 * re-deriving the elapsed time here (one clock, one decision).
 */
function probedNote(
  t: (key: string, params?: Readonly<Record<string, string>>) => string,
  age: { readonly key: string; readonly params: Readonly<Record<string, string>> } | null,
): string {
  if (age === null) return t("settings.infra.not_probed");
  if (age.key === "age.now") return t("settings.infra.checked_now");
  return t("settings.infra.checked", { age: t(age.key, age.params) });
}

/** Tone/label for a deployment connection, split by whether a probe ran. */
export function infraStatusOf(
  status: Connection["status"],
  probed: boolean,
): { tone: BadgeTone; icon: string; key: string } {
  if (status === "unconfigured") {
    // Never `degraded`: "nobody set this up" and "this is broken" send an
    // operator to two different places, and only one of them is a fault.
    return { tone: "gray", icon: "○", key: "settings.status.unconfigured" };
  }
  if (status === "degraded") {
    return { tone: "red", icon: "✕", key: "settings.status.degraded" };
  }
  return probed
    ? { tone: "green", icon: "●", key: "settings.status.connected" }
    : { tone: "blue", icon: "◍", key: "settings.status.configured" };
}
