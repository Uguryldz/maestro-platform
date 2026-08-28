import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { headerValue, readRawBody, requestUrl, sendJson, sendText } from "./http.js";
import type { DemoRun } from "./run.js";
import type { DemoState, StateStore } from "./state.js";

/**
 * The single page the demo is watched from, plus the two webhook endpoints the
 * fake Jira and the fake ADO deliver to. This is the demo's tiny stand-in for
 * `apps/bff`: `node:http` only, no framework, no new dependency.
 */

const PAGE = readFileSync(new URL("./ui.html", import.meta.url), "utf8");

export interface UiServerOptions {
  store: StateStore;
  run: DemoRun;
  /** Starts the flow; rejects if one is already running. */
  start: () => Promise<void>;
  /**
   * Base URL of the fake Jira. The browser never talks to it directly: the
   * page is often opened from another machine (or through a reverse proxy),
   * where the fake Jira's own address resolves to the viewer's laptop. The UI
   * server relays instead, so everything the browser touches is same-origin.
   */
  jiraUrl: string;
}

export function createUiServer(options: UiServerOptions): Server {
  const clients = new Set<ServerResponse>();

  const broadcast = (state: DemoState): void => {
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

    // Same-origin relay to the fake Jira (see UiServerOptions.jiraUrl).
    if (url.pathname === "/api/jira/state" && method === "GET") {
      const upstream = await fetch(`${options.jiraUrl}/_demo/state`);
      sendJson(res, upstream.status, await upstream.json());
      return;
    }

    if (url.pathname === "/api/jira/comment" && method === "POST") {
      const body = await readRawBody(req);
      const upstream = await fetch(`${options.jiraUrl}/_demo/comment`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      sendJson(res, upstream.status, await upstream.json().catch(() => ({})));
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

    if (url.pathname === "/api/start" && method === "POST") {
      await readRawBody(req);
      if (options.store.snapshot().running) {
        sendJson(res, 409, { error: "akış zaten çalışıyor" });
        return;
      }
      sendJson(res, 202, { ok: true });
      void options.start();
      return;
    }

    if (url.pathname === "/webhooks/jira" && method === "POST") {
      const raw = await readRawBody(req);
      const signature = headerValue(req, "x-hub-signature") ?? "";
      try {
        await options.run.handleJiraWebhook(raw, { "x-hub-signature": signature });
        sendJson(res, 200, { ok: true });
      } catch (error) {
        options.store.log("err", `✗ jira webhook reddedildi: ${String(error)}`);
        sendJson(res, 401, { error: String(error) });
      }
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
