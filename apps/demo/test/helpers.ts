import { createServer, type Server } from "node:http";
import { close, listen, readRawBody } from "../src/http.js";

/** Collects webhook deliveries so a test can assert on the RAW body. */
export interface Capture {
  server: Server;
  url: string;
  received: Array<{ headers: Record<string, string>; raw: string }>;
  close(): Promise<void>;
}

export async function startCapture(): Promise<Capture> {
  const received: Array<{ headers: Record<string, string>; raw: string }> = [];
  const server = createServer((req, res) => {
    void readRawBody(req).then((raw) => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        headers[name] = Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
      }
      received.push({ headers, raw });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  const port = await listen(server, 0);
  return { server, url: `http://127.0.0.1:${port}`, received, close: () => close(server) };
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 15_000,
  label = "koşul",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${label} ${timeoutMs} ms içinde gerçekleşmedi`);
}
