import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useSearchParams } from "react-router";
import type { PlatformProfile } from "@maestro/contracts";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Card, EmptyState, Table } from "../ui/index.ts";
import { MaybeUnwired } from "./shared/unwired.tsx";

/**
 * Screen: greenfield — the flow for a ticket whose repository does not exist yet.
 *
 * Steps: analysis → AI architecture proposal → HUMAN architecture approval →
 * repo + policy setup → skeleton session → first PR.
 *
 * The approval control is deliberately NOT here: gate decisions go through the
 * human channel (Jira `/approve`, or the gate screen), and a delegated session
 * is refused one by the BFF anyway (403 human_channel_only). A button here that
 * could not be honoured would be a dead path, so this screen reports state and
 * says where the decision is made.
 */

interface GreenfieldStep {
  readonly stepId: string;
  /** "done" | "active" | "pending" */
  readonly state: string;
}

interface ArchitectureProposal {
  readonly stack: string;
  readonly modules: readonly string[];
  readonly repoLayout: string;
  readonly dependencies: readonly string[];
  readonly platform: PlatformProfile;
  readonly pipeline: string;
}

interface GreenfieldResponse {
  readonly ticketKey: string;
  readonly title: string;
  readonly steps: readonly GreenfieldStep[];
  /** null until the AI has produced one. */
  readonly proposal: ArchitectureProposal | null;
}

const STEP_TONE = (state: string): "green" | "amber" | "gray" => {
  if (state === "done") return "green";
  if (state === "active") return "amber";
  return "gray";
};

export function GreenfieldScreen(): ReactNode {
  const t = useT();
  const api = useApi();
  const [params] = useSearchParams();
  const ticket = params.get("ticket");

  const query = useQuery({
    queryKey: ["greenfield", ticket],
    enabled: ticket !== null,
    queryFn: ({ signal }) =>
      api.get<GreenfieldResponse>("/greenfield", {
        query: { ticket: ticket ?? "" },
        signal,
      }),
  });

  if (ticket === null) {
    return (
      <Card title={t("greenfield.flow")}>
        <EmptyState
          icon="✦"
          title={t("greenfield.pick_ticket")}
          description={t("greenfield.pick_hint")}
        />
      </Card>
    );
  }

  const data = query.data;

  return (
    <>
      <Card
        title={data === undefined ? t("greenfield.flow") : `${data.ticketKey} — ${data.title}`}
        subtitle={t("greenfield.flow_sub")}
        padded={false}
      >
        <MaybeUnwired
          isPending={query.isPending}
          error={query.error}
          isEmpty={(data?.steps ?? []).length === 0}
          emptyTitle={t("greenfield.no_steps")}
          onRetry={() => void query.refetch()}
        >
          <Table
            columns={[
              {
                key: "step",
                header: t("greenfield.col.step"),
                cell: (row: GreenfieldStep) => t(`greenfield.step.${row.stepId}`),
              },
              {
                key: "state",
                header: t("greenfield.col.state"),
                cell: (row) => (
                  <Badge tone={STEP_TONE(row.state)}>{t(`greenfield.state.${row.state}`)}</Badge>
                ),
              },
            ]}
            rows={data?.steps ?? []}
            rowKey={(row) => row.stepId}
            emptyLabel={t("greenfield.no_steps")}
          />
        </MaybeUnwired>
      </Card>

      <div style={{ marginTop: 14 }}>
        <Card title={t("greenfield.proposal")} subtitle={t("greenfield.proposal_sub")}>
          <MaybeUnwired isPending={query.isPending} error={query.error}>
            {data?.proposal == null ? (
              <EmptyState icon="🧭" title={t("greenfield.no_proposal")} />
            ) : (
              <dl className="tpl-keyline">
                <dt>{t("greenfield.stack")}</dt>
                <dd>{data.proposal.stack}</dd>
                <dt>{t("greenfield.modules")}</dt>
                <dd>{data.proposal.modules.join(" · ")}</dd>
                <dt>{t("greenfield.repo_layout")}</dt>
                <dd>
                  <code>{data.proposal.repoLayout}</code>
                </dd>
                <dt>{t("greenfield.dependencies")}</dt>
                <dd>{data.proposal.dependencies.join(" · ")}</dd>
                <dt>{t("greenfield.platform")}</dt>
                <dd>
                  <Badge tone="teal">{data.proposal.platform}</Badge>
                </dd>
                <dt>{t("greenfield.pipeline")}</dt>
                <dd>{data.proposal.pipeline}</dd>
              </dl>
            )}
          </MaybeUnwired>
        </Card>
      </div>

      <p className="tpl-keyline" style={{ marginTop: 12 }}>
        {t("greenfield.human_approval_note")}
      </p>
    </>
  );
}
