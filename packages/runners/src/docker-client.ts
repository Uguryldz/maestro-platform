import type { DockerTransport } from "./deps.js";
import { DockerHttpError, DockerResponseError } from "./errors.js";
import { decodeResponse, encodeRequest, type HttpRequest, type HttpResponse, query } from "./http.js";

/**
 * The slice of the Docker Engine API this driver uses (M24: the Runner Service
 * is the only component holding the socket, and it holds a NARROW client —
 * there is deliberately no exec, no image push, no swarm here).
 */

export interface DockerClientOptions {
  transport: DockerTransport;
  apiVersion: string;
  requestTimeoutMs: number;
}

export interface ContainerSpec {
  Image: string;
  Cmd: string[];
  [field: string]: unknown;
}

export interface StreamTails {
  stdout: string;
  stderr: string;
}

const DETAIL_LIMIT = 300;

export class DockerClient {
  readonly #transport: DockerTransport;
  readonly #prefix: string;
  readonly #timeoutMs: number;

  constructor(options: DockerClientOptions) {
    this.#transport = options.transport;
    this.#prefix = `/${options.apiVersion}`;
    this.#timeoutMs = options.requestTimeoutMs;
  }

  /** `GET /_ping` — liveness of the daemon, used by the smoke test. */
  async ping(): Promise<boolean> {
    const response = await this.#send({ method: "GET", path: "/_ping" }, "_ping", { versioned: false });
    return response.status === 200;
  }

  async createContainer(name: string, spec: ContainerSpec): Promise<string> {
    const path = `/containers/create${query({ name })}`;
    const response = await this.#send({ method: "POST", path, body: JSON.stringify(spec) }, "containers/create");
    const id = asRecord(response, "containers/create")["Id"];
    if (typeof id !== "string" || id.length === 0) {
      throw new DockerResponseError("containers/create", "response has no container Id");
    }
    return id;
  }

  async startContainer(id: string): Promise<void> {
    await this.#send({ method: "POST", path: `/containers/${encode(id)}/start` }, "containers/start");
  }

  /**
   * Blocks until the container exits and returns its exit code. The caller
   * races this against the M23 timeout, so the request gets its own (longer)
   * transport budget — the daemon holds the connection open meanwhile.
   */
  async waitContainer(id: string, timeoutMs: number): Promise<number> {
    const response = await this.#send(
      { method: "POST", path: `/containers/${encode(id)}/wait` },
      "containers/wait",
      { timeoutMs },
    );
    const status = asRecord(response, "containers/wait")["StatusCode"];
    if (typeof status !== "number" || !Number.isInteger(status)) {
      throw new DockerResponseError("containers/wait", "response has no integer StatusCode");
    }
    return status;
  }

  /** SIGKILL by default (M23: the timeout must actually kill the process). */
  async killContainer(id: string, signal = "SIGKILL"): Promise<void> {
    await this.#send(
      { method: "POST", path: `/containers/${encode(id)}/kill${query({ signal })}` },
      "containers/kill",
      // 409 = already stopped: the job we wanted dead is dead.
      { tolerate: [404, 409] },
    );
  }

  async removeContainer(id: string, removeVolumes = false): Promise<void> {
    await this.#send(
      { method: "DELETE", path: `/containers/${encode(id)}${query({ force: true, v: removeVolumes })}` },
      "containers/remove",
      { tolerate: [404] },
    );
  }

  /** Log tail of a finished (or killed) container — the partial output of M23. */
  async containerLogs(id: string, tailLines: number): Promise<StreamTails> {
    const path = `/containers/${encode(id)}/logs${query({ stdout: 1, stderr: 1, tail: tailLines })}`;
    const response = await this.#send({ method: "GET", path }, "containers/logs", { tolerate: [404], raw: true });
    return demultiplex(response.body);
  }

  /** Idempotent: Docker answers 201 for a volume that already exists. */
  async createVolume(
    name: string,
    labels: Record<string, string>,
    driver = "local",
    driverOpts: Record<string, string> = {},
  ): Promise<void> {
    const body = JSON.stringify({ Name: name, Driver: driver, DriverOpts: driverOpts, Labels: labels });
    await this.#send({ method: "POST", path: "/volumes/create", body }, "volumes/create");
  }

  /** `undefined` for a volume that does not exist — 404 is an answer, not a failure. */
  async inspectVolume(name: string): Promise<{ labels: Record<string, string> } | undefined> {
    const response = await this.#send({ method: "GET", path: `/volumes/${encode(name)}` }, "volumes/inspect", {
      tolerate: [404],
    });
    if (response.status === 404) return undefined;
    return { labels: stringMap(asRecord(response, "volumes/inspect")["Labels"]) };
  }

  /** Reports whether the volume WAS there: the audit trail must not claim a deletion that never happened. */
  async removeVolume(name: string, force = false): Promise<boolean> {
    const response = await this.#send(
      { method: "DELETE", path: `/volumes/${encode(name)}${query({ force })}` },
      "volumes/remove",
      { tolerate: [404] },
    );
    return response.status !== 404;
  }

  /**
   * Network identity + isolation (M26). `Internal` is the field that decides
   * whether a job can route anywhere except the proxy, and `Name` is checked by
   * the caller because the daemon also resolves ID PREFIXES here.
   */
  async inspectNetwork(name: string): Promise<{ name: string; internal: boolean } | undefined> {
    const response = await this.#send({ method: "GET", path: `/networks/${encode(name)}` }, "networks/inspect", {
      tolerate: [404],
    });
    if (response.status === 404) return undefined;
    const record = asRecord(response, "networks/inspect");
    const found = record["Name"];
    if (typeof found !== "string") throw new DockerResponseError("networks/inspect", "response has no Name");
    return { name: found, internal: record["Internal"] === true };
  }

  /** Resolves a local image to its content-addressed id (M27 digest pinning). */
  async inspectImage(reference: string): Promise<{ id: string; repoDigests: string[] }> {
    const response = await this.#send({ method: "GET", path: `/images/${encode(reference)}/json` }, "images/inspect");
    const record = asRecord(response, "images/inspect");
    const id = record["Id"];
    if (typeof id !== "string") throw new DockerResponseError("images/inspect", "response has no image Id");
    const repoDigests = Array.isArray(record["RepoDigests"])
      ? record["RepoDigests"].filter((value): value is string => typeof value === "string")
      : [];
    return { id, repoDigests };
  }

  async #send(
    request: HttpRequest,
    endpoint: string,
    options: { tolerate?: number[]; timeoutMs?: number; versioned?: boolean; raw?: boolean } = {},
  ): Promise<HttpResponse> {
    const path = options.versioned === false ? request.path : `${this.#prefix}${request.path}`;
    const bytes = await this.#transport.exchange(encodeRequest({ ...request, path }), {
      timeoutMs: options.timeoutMs ?? this.#timeoutMs,
    });
    const response = decodeResponse(bytes);
    if (response.status >= 200 && response.status < 300) return response;
    if (options.tolerate?.includes(response.status)) return response;
    throw new DockerHttpError(response.status, endpoint, errorDetail(response));
  }
}

/** Docker error bodies are `{"message": "..."}`; anything else is passed through, truncated. */
function errorDetail(response: HttpResponse): string {
  const text = Buffer.from(response.body).toString("utf8").trim();
  try {
    const parsed: unknown = JSON.parse(text);
    const message = (parsed as { message?: unknown } | null)?.message;
    if (typeof message === "string") return truncate(message);
  } catch {
    /* not JSON — fall through to the raw text */
  }
  return truncate(text);
}

function truncate(value: string): string {
  return value.length <= DETAIL_LIMIT ? value : `${value.slice(0, DETAIL_LIMIT)}…`;
}

function asRecord(response: HttpResponse, endpoint: string): Record<string, unknown> {
  const text = Buffer.from(response.body).toString("utf8").trim();
  if (text.length === 0) throw new DockerResponseError(endpoint, "empty body");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DockerResponseError(endpoint, "body is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DockerResponseError(endpoint, "body is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function encode(segment: string): string {
  return encodeURIComponent(segment);
}

/** Docker sends `null` for "no labels"; anything non-string is dropped rather than coerced. */
function stringMap(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const map: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") map[key] = entry;
  }
  return map;
}

const FRAME_HEADER_BYTES = 8;
const STDERR_STREAM = 2;

/**
 * Demultiplexes Docker's non-TTY log stream: 8-byte header
 * (`stream, 0, 0, 0, size:uint32be`) followed by the payload. A stream that
 * does not parse as frames is a TTY stream and is returned as stdout — the
 * fallback keeps partial output readable instead of throwing it away.
 */
export function demultiplex(bytes: Uint8Array): StreamTails {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let offset = 0;
  while (offset + FRAME_HEADER_BYTES <= buffer.byteLength) {
    const stream = buffer[offset];
    const size = buffer.readUInt32BE(offset + 4);
    const start = offset + FRAME_HEADER_BYTES;
    if (stream === undefined || stream > 2 || start + size > buffer.byteLength) {
      return { stdout: buffer.toString("utf8"), stderr: "" };
    }
    (stream === STDERR_STREAM ? err : out).push(buffer.subarray(start, start + size));
    offset = start + size;
  }
  if (offset !== buffer.byteLength) return { stdout: buffer.toString("utf8"), stderr: "" };
  return { stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") };
}

/** Keeps the LAST `maxBytes` of a stream — the end is where the failure is. */
export function tail(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return text;
  return bytes.subarray(bytes.byteLength - maxBytes).toString("utf8");
}
