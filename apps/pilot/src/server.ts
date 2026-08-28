import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AuditChain } from "@maestro/audit";
import { TicketKey } from "@maestro/contracts";
import {
  type AuditFilter,
  auditEventsToCsv,
  pageAuditEvents,
} from "./audit-report.js";
import { DOC_CONTENT_TYPE, type DocKind, type DocStore } from "./docs.js";
import { headerValue, readRawBody, requestUrl, sendJson, sendText } from "./http.js";
import type { PilotRun } from "./run.js";
import { SettingsValidationError, type PilotSettings, type SettingsStore } from "./settings.js";
import { isValidRule, type ListeningRulesStore } from "./listening.js";
import { GuidanceStore } from "./guidance.js";
import type { PilotState, StateStore } from "./state.js";

/**
 * The single page the pilot is watched from, plus the ADO Service Hook endpoint
 * the FAKE ADO delivers to. Unlike the demo there is NO Jira webhook route:
 * Atlassian Cloud cannot reach localhost, so gates are resolved by polling
 * (see run.ts). `node:http` only, no framework, no new dependency.
 */

const PAGE = readFileSync(new URL("./ui.html", import.meta.url), "utf8");

export interface UiServerOptions {
  store: StateStore;
  /** Runtime settings the ⚙ Ayarlar panel reads and writes (M71). */
  settings: SettingsStore;
  /**
   * The live listening-rule set (Faz 3). The BFF mirrors the DB rules here over
   * `/api/listening` so the pilot — which cannot read Postgres — discovers and
   * classifies tickets by the rules an admin edited in Studio.
   */
  listening: ListeningRulesStore;
  /**
   * The enabled analysis-guidance notes ("öğren"). The BFF mirrors the DB's
   * enabled notes here over `/api/guidance`; the analyst reads them so an
   * operator's uploaded knowledge shapes the next analysis.
   */
  guidance: GuidanceStore;
  run: PilotRun;
  /** Holds the generated analysis .docx/.pdf the download route streams. */
  docs: DocStore;
  /**
   * The hash-chained audit trail (M33). The regulator report (B13) reads it —
   * filtered/paged as JSON over `/api/audit`, downloaded as CSV over
   * `/api/audit.csv`.
   */
  audit: AuditChain;
  /**
   * Starts the flow for the chosen ticket; rejects if one is already running.
   * The optional hint carries the discovery row's STATUS so a status listening
   * rule can classify the flow (the ticket snapshot itself has no status).
   */
  start: (ticketKey: TicketKey, hint?: { status?: string }) => Promise<void>;
  /**
   * Called AFTER every successful settings update, with the new snapshot. The
   * composition root persists it (DB/file) so a restart keeps the UI's values.
   * Best-effort: a persistence failure must never fail the update itself.
   */
  onSettingsChanged?: (settings: PilotSettings) => void;
}

function isDocKind(value: string): value is DocKind {
  return value === "pdf" || value === "docx";
}

export function createUiServer(options: UiServerOptions): Server {
  const clients = new Set<ServerResponse>();

  const broadcast = (state: PilotState): void => {
    const frame = `data: ${JSON.stringify(state)}\n\n`;
    for (const client of clients) client.write(frame);
  };
  options.store.subscribe(broadcast);

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      sendJson(res, 500, { error: String(error) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = requestUrl(req);
    const method = req.method ?? "GET";

    if (url.pathname === "/" && method === "GET") {
      sendText(res, 200, PAGE, "text/html; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/state" && method === "GET") {
      sendJson(res, 200, options.store.snapshot());
      return;
    }

    // The finished runs, newest first — the "geçmiş işler" list. The live state
    // is one run; this is the history of the ones that ended.
    if (url.pathname === "/api/runs" && method === "GET") {
      sendJson(res, 200, { runs: options.store.historySnapshot() });
      return;
    }

    // ── B13 regulator report: the audit trail, filtered + paged (JSON) and
    // downloadable (CSV). Filters: from/to (ISO on `at`), actor, action, q
    // (substring). Both routes read the SAME chain, so the CSV can never diverge
    // from what the screen shows.
    if ((url.pathname === "/api/audit" || url.pathname === "/api/audit.csv") && method === "GET") {
      const params = url.searchParams;
      const filter: AuditFilter = {
        ...(params.get("from") ? { from: params.get("from") as string } : {}),
        ...(params.get("to") ? { to: params.get("to") as string } : {}),
        ...(params.get("actor") ? { actor: params.get("actor") as string } : {}),
        ...(params.get("action") ? { action: params.get("action") as string } : {}),
        ...(params.get("q") ? { q: params.get("q") as string } : {}),
      };
      const all = await options.audit.read();
      if (url.pathname === "/api/audit.csv") {
        // The CSV export ignores paging: a regulator wants the WHOLE filtered
        // window in one file, not page 1 of it.
        const filtered = pageAuditEvents(all, filter, 0, all.length + 1).events;
        const stamp = new Date().toISOString().slice(0, 10);
        res.setHeader("content-disposition", `attachment; filename="maestro-denetim-${stamp}.csv"`);
        sendText(res, 200, auditEventsToCsv(filtered), "text/csv; charset=utf-8");
        return;
      }
      const offset = Number(params.get("offset") ?? "0");
      const limit = Number(params.get("limit") ?? "50");
      sendJson(res, 200, pageAuditEvents(all, filter, offset, limit));
      return;
    }

    // The UI-editable operational settings (M71). GET returns the current
    // values — none is a secret; the store never holds tokens or fixed URLs.
    if (url.pathname === "/api/settings" && method === "GET") {
      sendJson(res, 200, options.settings.snapshot());
      return;
    }

    // POST validates + updates. MID-RUN GUARD: a settings change is REFUSED while
    // a run is in progress (409). The run snapshots its settings at start, so a
    // change never alters approver group / data class / model semantics
    // mid-flight — it applies cleanly to the NEXT run. This is the safe choice:
    // no gate is ever opened for one group and evaluated against another.
    if (url.pathname === "/api/settings" && method === "POST") {
      if (options.store.snapshot().running) {
        sendJson(res, 409, { error: "akış sürerken değiştirilemez" });
        return;
      }
      const raw = await readRawBody(req);
      const body = safeJson(raw);
      if (body === null) {
        sendJson(res, 400, { error: "geçerli bir JSON gövdesi gerekli" });
        return;
      }
      try {
        const before = options.settings.snapshot();
        const updated = options.settings.update(body);
        const changed = (Object.keys(updated) as Array<keyof typeof updated>).filter(
          (key) => before[key] !== updated[key],
        );
        options.store.log(
          "info",
          changed.length === 0
            ? "⚙ ayarlar POST edildi — değişiklik yok"
            : `⚙ ayarlar güncellendi (operatör): ${changed.join(", ")}`,
        );
        // Persist the new values through the composition root's hook (settings
        // survive a restart). Guarded: a persistence hiccup is logged and the
        // update still answers 200 — the in-memory store IS updated.
        try {
          options.onSettingsChanged?.(updated);
        } catch (error) {
          options.store.log("warn", `! ayarlar kalıcılaştırılamadı (bellekte güncel): ${String(error)}`);
        }
        sendJson(res, 200, updated);
      } catch (error) {
        if (error instanceof SettingsValidationError) {
          sendJson(res, 400, { error: error.message });
          return;
        }
        throw error;
      }
      return;
    }

    // The live listening rules (Faz 3). GET returns the current set; POST
    // REPLACES it wholesale with the array the BFF mirror sends (the same full
    // list Studio shows). No mid-run guard: a rule change only affects the NEXT
    // discovery pass and the NEXT ticket's classification, never a running flow.
    if (url.pathname === "/api/listening" && method === "GET") {
      sendJson(res, 200, { rules: options.listening.snapshot() });
      return;
    }
    // The enabled analysis-guidance notes ("öğren"), mirrored from the DB. POST
    // REPLACES the set; the analyst reads it on the next analysis. No mid-run
    // guard: guidance only affects the NEXT ticket's analysis.
    if (url.pathname === "/api/guidance" && method === "GET") {
      sendJson(res, 200, { notes: options.guidance.snapshot() });
      return;
    }
    if (url.pathname === "/api/guidance" && method === "POST") {
      const raw = await readRawBody(req);
      const body = safeJson(raw);
      const incoming = (body as { notes?: unknown } | null)?.notes;
      if (!Array.isArray(incoming)) {
        sendJson(res, 400, { error: "notes dizisi gerekli" });
        return;
      }
      options.guidance.set(incoming as { title: string; content: string }[]);
      options.store.log("info", `📚 bilgi kütüphanesi güncellendi: ${options.guidance.snapshot().length} not (analize katılacak)`);
      sendJson(res, 200, { notes: options.guidance.snapshot() });
      return;
    }

    if (url.pathname === "/api/listening" && method === "POST") {
      const raw = await readRawBody(req);
      const body = safeJson(raw);
      const incoming = (body as { rules?: unknown } | null)?.rules;
      if (!Array.isArray(incoming)) {
        sendJson(res, 400, { error: "rules dizisi gerekli" });
        return;
      }
      // Defence-in-depth: the mirror comes from the BFF over validated DB rows,
      // but the pilot still keeps only rules whose shape it understands — a
      // malformed entry is dropped, never stored with an unknown matchKind or
      // flowType that discovery/classification could not interpret.
      const rules = incoming.filter(isValidRule);
      options.listening.set(rules);
      options.store.log(
        "info",
        `👂 dinleme kuralları güncellendi: ${rules.length} kural` +
          (rules.length === incoming.length ? "" : ` (${incoming.length - rules.length} geçersiz atlandı)`),
      );
      sendJson(res, 200, { rules: options.listening.snapshot() });
      return;
    }

    // Download the generated analysis document. `/api/doc/pdf` or `/api/doc/docx`;
    // 404 until the analysis step has produced them for the current run.
    const docMatch = /^\/api\/doc\/([a-z]+)$/.exec(url.pathname);
    if (docMatch && method === "GET") {
      const kind = docMatch[1] ?? "";
      if (!isDocKind(kind)) {
        sendText(res, 404, "not found");
        return;
      }
      const generated = options.docs.get(kind);
      if (generated === null) {
        sendJson(res, 404, { error: "belge henüz üretilmedi" });
        return;
      }
      res.writeHead(200, {
        "content-type": DOC_CONTENT_TYPE[kind],
        "content-disposition": `attachment; filename="${generated.fileName}"`,
        "content-length": String(generated.bytes.byteLength),
        "cache-control": "no-store",
      });
      res.end(Buffer.from(generated.bytes));
      return;
    }

    if (url.pathname === "/api/events" && method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(options.store.snapshot())}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    // Pick a discovered ticket and start the flow for it.
    if (url.pathname === "/api/start" && method === "POST") {
      const raw = await readRawBody(req);
      if (options.store.snapshot().running) {
        sendJson(res, 409, { error: "akış zaten çalışıyor" });
        return;
      }
      const body = safeJson(raw);
      const parsed = TicketKey.safeParse(body?.["ticketKey"]);
      if (!parsed.success) {
        sendJson(res, 400, { error: "geçerli bir ticketKey gerekli" });
        return;
      }
      // Optional, backwards-compatible STATUS hint: the UI sends the selected
      // discovery row's status so a status listening rule can classify the
      // flow. Absent/malformed = no hint, exactly the old behaviour.
      const rawStatus = body?.["status"];
      const status = typeof rawStatus === "string" && rawStatus.trim().length > 0 ? rawStatus.trim() : undefined;
      sendJson(res, 202, { ok: true });
      void options.start(parsed.data, status === undefined ? undefined : { status });
      return;
    }

    if (url.pathname === "/webhooks/ado" && method === "POST") {
      const raw = await readRawBody(req);
      try {
        const body: unknown = JSON.parse(raw);
        await options.run.handleAdoWebhook(
          { authorization: headerValue(req, "authorization") ?? "" },
          body,
        );
        sendJson(res, 200, { ok: true });
      } catch (error) {
        options.store.log("err", `✗ ado service hook reddedildi: ${String(error)}`);
        sendJson(res, 401, { error: String(error) });
      }
      return;
    }

    sendText(res, 404, "not found");
  }

  return server;
}

function safeJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
