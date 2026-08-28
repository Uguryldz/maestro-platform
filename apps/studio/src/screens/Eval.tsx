import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { messageKeyOf } from "../api/errors.ts";
import { useApi } from "../auth/AuthProvider.tsx";
import { useAuth } from "../auth/AuthProvider.tsx";
import { hasRole } from "../auth/types.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Table, useToast } from "../ui/index.ts";
import { TextArea } from "./shared/TextArea.tsx";
import { MaybeUnwired } from "./shared/unwired.tsx";

/**
 * Screen: eval — golden-ticket regression testing (M38/M43/M78).
 *
 * Prompt and knowledge changes are regression-tested against a reference set of
 * real past tickets before a variant version is published. A score that DROPPED
 * against the baseline is called out explicitly: the whole point of the gate is
 * that a regression is visible before publishing, not after.
 *
 * When the last run REGRESSED, an admin must record a decision: ship it with a
 * written justification (the M78 justified pass) or block it. The BFF refuses a
 * silent pass — shipping a regression with no justification is a 409 — so this
 * screen requires the reason before the "ship" button does anything.
 */

interface GoldenTicket {
  readonly goldenId: string;
  readonly sourceTicket: string;
  readonly kind: string;
  readonly expectation: string;
  readonly lastScore: number | null;
}

interface EvalRunResult {
  readonly goldenId: string;
  readonly baselineScore: number | null;
  readonly candidateScore: number | null;
}

type EvalDecisionStatus = "pending" | "shipped" | "blocked";

interface EvalDecision {
  readonly status: EvalDecisionStatus;
  readonly justification: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
}

interface EvalRun {
  readonly runId: string;
  readonly baselineVersion: number;
  readonly candidateVersion: number;
  readonly variantId: string;
  readonly at: string;
  readonly results: readonly EvalRunResult[];
  readonly decision: EvalDecision;
}

interface EvalResponse {
  readonly goldenTickets: readonly GoldenTicket[];
  /** null when no eval has been run yet. */
  readonly lastRun: EvalRun | null;
}

/** Regression = the candidate scored strictly worse than the baseline. */
function isRegression(result: EvalRunResult): boolean {
  return (
    result.baselineScore !== null &&
    result.candidateScore !== null &&
    result.candidateScore < result.baselineScore
  );
}

export function EvalScreen(): ReactNode {
  const t = useT();
  const api = useApi();
  const { session } = useAuth();
  const isAdmin = hasRole(session, "admin");

  const query = useQuery({
    queryKey: ["eval"],
    queryFn: ({ signal }) => api.get<EvalResponse>("/eval", { signal }),
  });

  const lastRun = query.data?.lastRun ?? null;
  const regressions = (lastRun?.results ?? []).filter(isRegression).length;

  return (
    <>
      <Card title={t("eval.pool")} subtitle={t("eval.pool_sub")} padded={false}>
        <MaybeUnwired
          isPending={query.isPending}
          error={query.error}
          isEmpty={(query.data?.goldenTickets ?? []).length === 0}
          emptyTitle={t("eval.no_golden")}
          onRetry={() => void query.refetch()}
        >
          <Table
            columns={[
              { key: "id", header: t("eval.col.id"), cell: (row: GoldenTicket) => row.goldenId },
              { key: "source", header: t("eval.col.source"), cell: (row) => row.sourceTicket },
              {
                key: "kind",
                header: t("eval.col.kind"),
                cell: (row) => <Badge tone="gray">{row.kind}</Badge>,
              },
              {
                key: "expectation",
                header: t("eval.col.expectation"),
                cell: (row) => row.expectation,
              },
              {
                key: "score",
                header: t("eval.col.last_score"),
                cell: (row) =>
                  row.lastScore === null ? (
                    <Badge tone="gray">{t("variants.never_evaluated")}</Badge>
                  ) : (
                    <Badge tone={row.lastScore >= 90 ? "green" : "amber"}>{String(row.lastScore)}</Badge>
                  ),
                align: "right",
              },
            ]}
            rows={query.data?.goldenTickets ?? []}
            rowKey={(row) => row.goldenId}
            emptyLabel={t("eval.no_golden")}
          />
        </MaybeUnwired>
      </Card>

      <div style={{ marginTop: 14 }}>
        <Card
          title={t("eval.last_run")}
          subtitle={
            lastRun === null
              ? undefined
              : t("eval.last_run_sub", {
                  variant: lastRun.variantId,
                  from: String(lastRun.baselineVersion),
                  to: String(lastRun.candidateVersion),
                  at: lastRun.at,
                })
          }
          actions={
            regressions > 0 ? (
              <Badge tone="red">{t("eval.regressions_n", { n: String(regressions) })}</Badge>
            ) : undefined
          }
          padded={false}
        >
          <MaybeUnwired
            isPending={query.isPending}
            error={query.error}
            isEmpty={lastRun === null || lastRun.results.length === 0}
            emptyTitle={t("eval.never_run")}
          >
            <Table
              columns={[
                {
                  key: "id",
                  header: t("eval.col.id"),
                  cell: (row: EvalRunResult) => row.goldenId,
                },
                {
                  key: "baseline",
                  header: t("eval.col.baseline"),
                  cell: (row) => (row.baselineScore === null ? "—" : String(row.baselineScore)),
                  align: "right",
                },
                {
                  key: "candidate",
                  header: t("eval.col.candidate"),
                  cell: (row) => (row.candidateScore === null ? "—" : String(row.candidateScore)),
                  align: "right",
                },
                {
                  key: "delta",
                  header: t("eval.col.verdict"),
                  cell: (row) =>
                    isRegression(row) ? (
                      <Badge tone="red">{t("eval.regressed")}</Badge>
                    ) : (
                      <Badge tone="green">{t("eval.no_regression")}</Badge>
                    ),
                },
              ]}
              rows={lastRun?.results ?? []}
              rowKey={(row) => row.goldenId}
              emptyLabel={t("eval.never_run")}
            />
          </MaybeUnwired>
        </Card>
      </div>

      {lastRun !== null && (
        <div style={{ marginTop: 14 }}>
          <DecisionPanel run={lastRun} regressions={regressions} isAdmin={isAdmin} />
        </div>
      )}

      <p className="tpl-keyline" style={{ marginTop: 12 }}>
        {t("eval.gate_note")}
      </p>
    </>
  );
}

/**
 * The M78 gate. A run with a regression may only be shipped WITH a written
 * justification; blocking needs none. Once decided, the panel shows the recorded
 * outcome rather than the buttons — the decision is on the audit trail and is
 * not re-taken from here casually.
 */
function DecisionPanel({
  run,
  regressions,
  isAdmin,
}: {
  readonly run: EvalRun;
  readonly regressions: number;
  readonly isAdmin: boolean;
}): ReactNode {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [justification, setJustification] = useState("");

  const decide = useMutation({
    mutationFn: (status: "shipped" | "blocked") =>
      api.post<EvalRun>("/eval/decisions", {
        runId: run.runId,
        status,
        justification: justification.trim(),
      }),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: ["eval"] });
      toast.show(
        updated.decision.status === "shipped" ? "success" : "warning",
        t(`eval.toast.${updated.decision.status}`),
      );
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const decided = run.decision.status !== "pending";

  if (decided) {
    return (
      <Card title={t("eval.decision.title")}>
        <p>
          <Badge tone={run.decision.status === "shipped" ? "green" : "red"}>
            {t(`eval.decision.${run.decision.status}`)}
          </Badge>{" "}
          {run.decision.decidedBy !== null &&
            t("eval.decision.by", {
              by: run.decision.decidedBy,
              at: run.decision.decidedAt ?? "",
            })}
        </p>
        {run.decision.justification !== "" && (
          <p className="scr-prose" style={{ marginTop: 8 }}>
            <b>{t("eval.decision.justification")}:</b> {run.decision.justification}
          </p>
        )}
      </Card>
    );
  }

  if (!isAdmin) {
    return (
      <Card title={t("eval.decision.title")}>
        <div className="scr-note">{t("eval.decision.pending_readonly")}</div>
      </Card>
    );
  }

  const needsJustification = regressions > 0;
  const shipBlocked = needsJustification && justification.trim() === "";

  return (
    <Card title={t("eval.decision.title")} subtitle={t("eval.decision.sub")}>
      {needsJustification ? (
        <div className="scr-note scr-note--warn" style={{ marginBottom: 10 }}>
          {t("eval.decision.regression_warn", { n: String(regressions) })}
        </div>
      ) : (
        <div className="scr-note" style={{ marginBottom: 10 }}>
          {t("eval.decision.clean")}
        </div>
      )}

      {needsJustification && (
        <TextArea
          label={t("eval.decision.justification")}
          rows={4}
          value={justification}
          onChange={(event) => setJustification(event.target.value)}
          hint={t("eval.decision.justification_hint")}
        />
      )}

      <div className="scr-row" style={{ gap: 8, marginTop: 10 }}>
        <Button
          variant="primary"
          busy={decide.isPending}
          disabled={shipBlocked}
          onClick={() => decide.mutate("shipped")}
        >
          {t("eval.decision.ship")}
        </Button>
        <Button variant="danger" busy={decide.isPending} onClick={() => decide.mutate("blocked")}>
          {t("eval.decision.block")}
        </Button>
      </div>
    </Card>
  );
}
