import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** Reads the RAW request body — webhook signatures are computed over these bytes. */
export async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(text);
}

export function sendText(
  res: ServerResponse,
  status: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
): void {
  res.writeHead(status, { "content-type": contentType });
  res.end(body);
}

/** Permissive CORS for the demo-only routes the browser talks to directly. */
export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

/** Case-insensitive single header value. */
export function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** `new URL` needs an origin; requests only ever carry a path here. */
export function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://localhost");
}

/**
 * Bind address. Loopback by default — the demo has no authentication and
 * burns real model quota, so it must not be reachable from the network unless
 * somebody asks for it. `MAESTRO_DEMO_HOST=0.0.0.0` opens it deliberately
 * (e.g. to watch it from another machine or through a reverse proxy).
 */
const BIND_HOST = process.env["MAESTRO_DEMO_HOST"] ?? "127.0.0.1";

export function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, BIND_HOST, () => {
      const address = server.address() as AddressInfo | null;
      resolve(address?.port ?? port);
    });
  });
}

export function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** JSON body or `null` when the payload is not an object. */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
