import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import type { AuditEvent } from "@maestro/contracts";
import { messageKeyOf } from "../api/errors.ts";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Input, Table, useToast } from "../ui/index.ts";
import { assess, type ChainVerification } from "./audit/verification.ts";
import { useEnumLabel } from "./common/label.ts";
import { QueryState } from "./shared/QueryState.tsx";
import { shortHash } from "./shared/format.ts";
import "./shared/screens.css";

/**
 * Screen: audit — the hash-chained audit trail (M33).
 *
 * SECURITY: the chain's own claim is not evidence about itself. This screen
 * never renders a bare `ok: true` as a green badge; it shows the verdict
 * together with what it rests on — how many records were re-hashed — and
 * downgrades an `ok` that checked nothing to amber. It also states plainly that
 * recomputation shows internal consistency, not tamper-proofing, because the
 * endpoint reports no external anchor. See ./audit/verification.ts.
 *
 * Both endpoints are auditor-only in the BFF (403 for everyone else); that
 * failure surfaces translated, like any other.
 *
 * B13: the trail is filterable (date window, exact actor/action, free-text
 * needle) and the applied window is downloadable whole as CSV over
 * `GET /studio/audit.csv` — same filters, no paging, bearer-authenticated via
 * `getBlob` because a bare `<a href>` would arrive without the session token.
 */

/** `GET /studio/audit` — a page of the trail. */
interface AuditPage {
  readonly items: readonly AuditEvent[];
  readonly nextCursor: string | null;
}

const ACTION_TONE = (action: string): "green" | "red" | "amber" | "gray" => {
  if (action.includes("APPROVE") || action.includes("PASS") || action.includes("MERGED")) return "green";
  if (action.includes("REJECT") || action.includes("FAIL") || action.includes("KILL")) return "red";
  if (action.includes("WARN") || action.includes("HANDOVER")) return "amber";
  return "gray";
};

/**
 * The auditor's filter row (B13): a date window, exact actor/action, and a
 * free-text needle. Draft values live in the inputs; only "Getir" applies them,
 * so typing never fires a query per keystroke.
 */
interface AuditFilters {
  readonly from: string;
  readonly to: string;
  readonly actor: string;
  readonly action: string;
  readonly q: string;
}

const EMPTY_FILTERS: AuditFilters = { from: "", to: "", actor: "", action: "", q: "" };

/**
 * The wire params an applied filter produces. `<input type="date">` gives
 * YYYY-MM-DD; the bounds are widened to the day's edges in ISO so the window is
 * inclusive of everything that happened on the chosen dates (the BFF compares
 * ISO strings lexically, both bounds inclusive). Empty fields are omitted —
 * the ApiClient drops `undefined` query values.
 */
function filterQuery(filters: AuditFilters): Record<string, string | undefined> {
  return {
    from: filters.from === "" ? undefined : `${filters.from}T00:00:00.000Z`,
    to: filters.to === "" ? undefined : `${filters.to}T23:59:59.999Z`,
    actor: filters.actor.trim() === "" ? undefined : filters.actor.trim(),
    action: filters.action.trim() === "" ? undefined : filters.action.trim(),
    q: filters.q.trim() === "" ? undefined : filters.q.trim(),
  };
}

export function AuditScreen(): ReactNode {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const enumLabel = useEnumLabel();

  const [draft, setDraft] = useState<AuditFilters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<AuditFilters>(EMPTY_FILTERS);
  const [downloading, setDownloading] = useState(false);

  const query = filterQuery(applied);
  const events = useQuery({
    // The applied filters are part of the key: changing them is a different
    // question, and TanStack caches the answers separately.
    queryKey: ["audit", "events", query],
    queryFn: ({ signal }) => api.get<AuditPage>("/studio/audit", { signal, query }),
  });

  const applyFilters = (): void => {
    if (JSON.stringify(draft) === JSON.stringify(applied)) {
      // Same filters twice — the auditor still asked for fresh rows.
      void events.refetch();
      return;
    }
    setApplied(draft);
  };

  /**
   * The CSV goes through `getBlob` rather than a plain `<a href>` because the
   * session token travels in a header the browser would not attach on its own.
   * It exports the APPLIED filters — the same window the table shows.
   */
  const downloadCsv = async (): Promise<void> => {
    setDownloading(true);
    try {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(filterQuery(applied))) {
        if (value !== undefined) search.set(key, value);
      }
      const qs = search.toString();
      const blob = await api.getBlob(`/studio/audit.csv${qs === "" ? "" : `?${qs}`}`);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `maestro-denetim-${new Date().toISOString().slice(0, 10)}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.show("error", t(messageKeyOf(error)));
    } finally {
      setDownloading(false);
    }
  };

  /**
   * The verification is a GET because it changes nothing — it recomputes and
   * compares. It is a separate query so a broken trail still renders its rows:
   * the events are the evidence an auditor came for, and withholding them
   * because the integrity check failed would be exactly backwards.
   */
  const verification = useQuery({
    queryKey: ["audit", "verification"],
    queryFn: ({ signal }) => api.get<ChainVerification>("/studio/audit/verification", { signal }),
  });

  const verdict = assess(verification.data);

  return (
    <>
      <Card
        title={t("audit.chain")}
        subtitle={t("audit.chain_sub")}
        actions={
          <Button
            variant="primary"
            busy={verification.isFetching}
            onClick={() => void verification.refetch()}
          >
            {t("audit.verify_now")}
          </Button>
        }
      >
        <QueryState
          isPending={verification.isPending}
          error={verification.error}
          onRetry={() => void verification.refetch()}
        >
          <p>
            <Badge tone={verdict.tone}>{t(`audit.assessment.${verdict.assessment}`)}</Badge>
          </p>
          <ul className="tpl-keyline" style={{ marginTop: 8 }}>
            {verdict.basis.map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ul>
          {verification.data !== undefined && (
            <p className="tpl-keyline">
              {t("audit.checked_n", { n: String(verification.data.checked) })}
              {verification.data.brokenAtSeq !== null &&
                ` · ${t("audit.broken_at_seq", { seq: String(verification.data.brokenAtSeq) })}`}
            </p>
          )}
        </QueryState>
      </Card>

      <div style={{ marginTop: 14 }}>
        <Card title={t("audit.events")} padded={false}>
          <form
            className="screen-filters"
            style={{ alignItems: "flex-end", padding: "12px 14px" }}
            onSubmit={(event) => {
              event.preventDefault();
              applyFilters();
            }}
          >
            <Input
              label={t("audit.filter.from")}
              type="date"
              value={draft.from}
              onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            />
            <Input
              label={t("audit.filter.to")}
              type="date"
              value={draft.to}
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            />
            <Input
              label={t("audit.filter.actor")}
              placeholder={t("audit.filter.actor_ph")}
              value={draft.actor}
              onChange={(e) => setDraft({ ...draft, actor: e.target.value })}
            />
            <Input
              label={t("audit.filter.action")}
              placeholder={t("audit.filter.action_ph")}
              value={draft.action}
              onChange={(e) => setDraft({ ...draft, action: e.target.value })}
            />
            <Input
              label={t("audit.filter.q")}
              placeholder={t("audit.filter.q_ph")}
              value={draft.q}
              onChange={(e) => setDraft({ ...draft, q: e.target.value })}
            />
            <Button type="submit" variant="primary" busy={events.isFetching}>
              {t("audit.filter.fetch")}
            </Button>
            <Button busy={downloading} onClick={() => void downloadCsv()}>
              {t("audit.filter.csv")}
            </Button>
          </form>
          <QueryState
            isPending={events.isPending}
            error={events.error}
            isEmpty={(events.data?.items ?? []).length === 0}
            emptyTitle={t("audit.no_events")}
            onRetry={() => void events.refetch()}
          >
            <Table
              columns={[
                {
                  key: "seq",
                  header: t("audit.col.seq"),
                  cell: (row: AuditEvent) => String(row.seq),
                  align: "right",
                },
                { key: "at", header: t("audit.col.at"), cell: (row) => row.at },
                { key: "actor", header: t("audit.col.actor"), cell: (row) => row.actor },
                {
                  key: "action",
                  header: t("audit.col.action"),
                  // Translated, not raw. `ACTION_TONE` still keys off the enum
                  // — the colour is derived from the machine value, the words
                  // from the catalog.
                  cell: (row) => {
                    const label = enumLabel("audit.action", row.action);
                    return (
                      <Badge tone={label.unknown ? "gray" : ACTION_TONE(row.action)}>
                        {label.text}
                      </Badge>
                    );
                  },
                },
                { key: "subject", header: t("audit.col.subject"), cell: (row) => row.subject },
                {
                  key: "hash",
                  header: t("audit.col.hash"),
                  cell: (row) => <code>{shortHash(row.hash)}</code>,
                },
              ]}
              rows={events.data?.items ?? []}
              rowKey={(row) => String(row.seq)}
              emptyLabel={t("audit.no_events")}
            />
          </QueryState>
        </Card>
      </div>

      <p className="tpl-keyline" style={{ marginTop: 12 }}>
        {t("audit.single_writer_note")}
      </p>
    </>
  );
}
