import { useState } from "react";
import type { ReactNode } from "react";
import type { EvidenceFile, GateDecision } from "@maestro/contracts";
import { useI18n, useT } from "../i18n/I18nProvider.tsx";
import { Badge, Card, Input, Table } from "../ui/index.ts";
import type { Column } from "../ui/index.ts";
import { QueryState } from "./shared/QueryState.tsx";
import { byteSize, dateTimeLabel, shortHash } from "./shared/format.ts";
import { useEvidence } from "./shared/runs.ts";
import "./shared/screens.css";

/**
 * Screen: evidence — the audit file of a finished workflow (M56/M57).
 *
 * The manifest shape is `EvidencePackage` from packages/contracts: files with
 * a sha256 and a byte count, plus the signed approval chain. Two things this
 * screen deliberately does NOT do:
 *
 *  - it does not offer a download button, because there is no endpoint serving
 *    the archive and a button that 404s is worse than no button;
 *  - it does not compute or display a "SoD verified ✓" summary of its own. Each
 *    GateDecision carries `sodVerified` from the workflow that signed it; the
 *    table shows that field. A green tick invented by the client would be an
 *    audit claim with nothing behind it.
 *
 * Reads `GET /studio/runs/:ticket/evidence` (routes/studio-runs.ts:113).
 */
export function EvidenceScreen(): ReactNode {
  const t = useT();
  const { locale } = useI18n();
  const [ticket, setTicket] = useState("");

  const query = useEvidence(ticket.trim(), ticket.trim() !== "");
  const pkg = query.data;

  const fileColumns: readonly Column<EvidenceFile>[] = [
    {
      key: "name",
      header: t("evidence.col.file"),
      cell: (file) => <span className="screen-file__name">{file.name}</span>,
    },
    {
      key: "type",
      header: t("evidence.col.type"),
      cell: (file) => <span className="screen-note">{file.contentType}</span>,
    },
    {
      key: "hash",
      header: t("evidence.col.hash"),
      cell: (file) => <span className="screen-mono">{shortHash(file.sha256)}</span>,
    },
    {
      key: "size",
      header: t("evidence.col.size"),
      align: "right",
      cell: (file) => {
        const size = byteSize(file.bytes);
        return `${size.value} ${t(size.key)}`;
      },
    },
  ];

  const approvalColumns: readonly Column<GateDecision>[] = [
    {
      key: "step",
      header: t("evidence.col.gate"),
      cell: (decision) => (
        <>
          <span className="screen-mono">{decision.step}</span> {t(`steps.${decision.step}`)}
        </>
      ),
    },
    {
      key: "decision",
      header: t("evidence.col.decision"),
      cell: (decision) => (
        <Badge tone={decision.decision === "approve" ? "green" : "red"}>
          {t(`evidence.decision.${decision.decision}`)}
        </Badge>
      ),
    },
    {
      key: "actor",
      header: t("evidence.col.actor"),
      cell: (decision) => <span className="screen-mono">{decision.actorUserId}</span>,
    },
    {
      key: "sod",
      header: t("evidence.col.sod"),
      cell: (decision) => (
        <Badge tone={decision.sodVerified ? "green" : "red"}>
          {t(decision.sodVerified ? "evidence.sod.ok" : "evidence.sod.missing")}
        </Badge>
      ),
    },
    {
      key: "at",
      header: t("evidence.col.at"),
      align: "right",
      cell: (decision) => dateTimeLabel(decision.at, locale),
    },
  ];

  return (
    <div className="screen-stack">
      <Card title={t("evidence.pick.title")} subtitle={t("evidence.pick.subtitle")}>
        <Input
          label={t("evidence.field.ticket")}
          value={ticket}
          onChange={(event) => setTicket(event.target.value)}
          hint={t("evidence.field.ticket_hint")}
        />
      </Card>

      {ticket.trim() === "" ? (
        <Card>
          <p className="screen-note">{t("evidence.prompt")}</p>
        </Card>
      ) : (
        <QueryState
          isPending={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
          skeletonRows={6}
        >
          {pkg === undefined ? null : (
            <div className="screen-grid screen-grid--detail">
              <Card
                title={t("evidence.files.title")}
                subtitle={t("evidence.files.subtitle")}
                padded={false}
              >
                <Table
                  columns={fileColumns}
                  rows={pkg.files}
                  rowKey={(file) => file.name}
                  emptyLabel={t("evidence.files.empty")}
                  caption={t("evidence.files.caption")}
                />
              </Card>

              <div className="screen-stack">
                <Card title={t("evidence.summary.title")}>
                  <dl className="screen-kv">
                    <dt>{t("evidence.field.ticket_label")}</dt>
                    <dd className="screen-mono">{pkg.ticketKey}</dd>
                    <dt>{t("evidence.field.run")}</dt>
                    <dd className="screen-mono">{pkg.runId}</dd>
                    <dt>{t("evidence.field.created")}</dt>
                    <dd>{dateTimeLabel(pkg.createdAt, locale)}</dd>
                    <dt>{t("evidence.field.template")}</dt>
                    <dd>{pkg.templateVersion}</dd>
                    <dt>{t("evidence.field.files")}</dt>
                    <dd>{String(pkg.files.length)}</dd>
                    <dt>{t("evidence.field.retention")}</dt>
                    <dd>{t("evidence.field.retention_value", { n: String(pkg.retentionYears) })}</dd>
                    <dt>{t("evidence.field.object_lock")}</dt>
                    <dd>
                      <Badge tone={pkg.objectLock ? "green" : "gray"}>
                        {t(pkg.objectLock ? "evidence.lock.on" : "evidence.lock.off")}
                      </Badge>
                    </dd>
                  </dl>
                  <p className="screen-note">{t("evidence.summary.note")}</p>
                </Card>
              </div>

              <Card
                title={t("evidence.approvals.title")}
                subtitle={t("evidence.approvals.subtitle")}
                padded={false}
              >
                <Table
                  columns={approvalColumns}
                  rows={pkg.approvals}
                  rowKey={(decision) => `${decision.step}-${decision.signatureSeq}`}
                  emptyLabel={t("evidence.approvals.empty")}
                  caption={t("evidence.approvals.caption")}
                />
              </Card>
            </div>
          )}
        </QueryState>
      )}
    </div>
  );
}
