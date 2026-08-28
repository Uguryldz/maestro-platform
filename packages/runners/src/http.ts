import { DockerResponseError } from "./errors.js";

/**
 * The smallest HTTP/1.1 client that can drive the Docker Engine API, written
 * by hand on purpose: `dockerode` would pull a dependency tree (and a live
 * socket) into a package whose whole test suite must stay offline. Framing
 * lives here, bytes move through an injected `DockerTransport`.
 *
 * Requests always carry `Connection: close`, so one exchange is one
 * connection and the response ends at EOF — no keep-alive state machine.
 */

export interface HttpRequest {
  method: "GET" | "POST" | "DELETE";
  /** Path INCLUDING the query string, already percent-encoded. */
  path: string;
  headers?: Record<string, string>;
  /** JSON body; `Content-Type` and `Content-Length` are added for you. */
  body?: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

const CRLF = "\r\n";

export function encodeRequest(request: HttpRequest): Uint8Array {
  const headers: Record<string, string> = {
    Host: "docker",
    Accept: "application/json",
    Connection: "close",
    ...request.headers,
  };
  const body = request.body === undefined ? undefined : Buffer.from(request.body, "utf8");
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(body.byteLength);
  }
  const head = [
    `${request.method} ${request.path} HTTP/1.1`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    "",
    "",
  ].join(CRLF);
  const headBytes = Buffer.from(head, "utf8");
  return body === undefined ? headBytes : Buffer.concat([headBytes, body]);
}

const HEAD_END = Buffer.from("\r\n\r\n", "utf8");

export function decodeResponse(bytes: Uint8Array): HttpResponse {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const separator = buffer.indexOf(HEAD_END);
  if (separator < 0) throw new DockerResponseError("(transport)", "response has no header terminator");

  const lines = buffer.subarray(0, separator).toString("utf8").split(CRLF);
  const statusLine = lines[0] ?? "";
  const match = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine);
  if (!match?.[1]) throw new DockerResponseError("(transport)", `unparsable status line "${statusLine}"`);
  const status = Number(match[1]);

  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }

  const rest = buffer.subarray(separator + HEAD_END.length);
  return { status, headers, body: decodeBody(rest, headers) };
}

function decodeBody(rest: Buffer, headers: Record<string, string>): Uint8Array {
  if ((headers["transfer-encoding"] ?? "").toLowerCase().includes("chunked")) {
    return decodeChunked(rest);
  }
  const declared = headers["content-length"];
  if (declared !== undefined) {
    const length = Number(declared);
    if (!Number.isInteger(length) || length < 0) {
      throw new DockerResponseError("(transport)", `unparsable content-length "${declared}"`);
    }
    if (rest.byteLength < length) {
      // Fail-closed: a short body means the connection died mid-answer. Handing
      // back the fragment would let a truncated `wait` read as a clean exit.
      throw new DockerResponseError("(transport)", `body is ${rest.byteLength} bytes, content-length says ${length}`);
    }
    return rest.subarray(0, length);
  }
  return rest;
}

/** `chunked` decoder — Docker uses it for JSON list and log endpoints. */
function decodeChunked(rest: Buffer): Uint8Array {
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const lineEnd = rest.indexOf("\r\n", offset, "utf8");
    if (lineEnd < 0) throw new DockerResponseError("(transport)", "truncated chunk header");
    const sizeText = rest.subarray(offset, lineEnd).toString("utf8").split(";", 1)[0]?.trim() ?? "";
    if (!/^[0-9a-fA-F]+$/.test(sizeText)) {
      throw new DockerResponseError("(transport)", `unparsable chunk size "${sizeText}"`);
    }
    const size = Number.parseInt(sizeText, 16);
    const start = lineEnd + 2;
    if (size === 0) break;
    if (start + size > rest.byteLength) throw new DockerResponseError("(transport)", "truncated chunk body");
    parts.push(rest.subarray(start, start + size));
    offset = start + size + 2;
  }
  return Buffer.concat(parts);
}

/** Percent-encodes one query value (image refs and volume names contain `:`/`@`). */
export function query(params: Record<string, string | number | boolean | undefined>): string {
  const pairs = Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
  return pairs.length === 0 ? "" : `?${pairs.join("&")}`;
}
