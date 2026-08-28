import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AuditRecord, Clock, DockerTransport, IdSource, Timer } from "../src/deps.js";
import type { DockerLinuxRunner } from "../src/docker-runner.js";
import { decodeResponse } from "../src/http.js";
import { createDockerLinuxRunner } from "../src/register.js";

/**
 * Offline test rig. Every byte the driver sees comes either from a fixture
 * RECORDED against a real Docker Engine 29.4 (`fixtures/*.http`, captured with
 * the same raw framing this package speaks) or from `httpResponse` below —
 * never from a live daemon, and never from a hand-waved response shape.
 */

const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/", import.meta.url));

export function fixture(name: string): Uint8Array {
  return readFileSync(`${FIXTURE_DIR}${name}`);
}

export const FIXTURES = {
  ping: () => fixture("ping.http"),
  create: () => fixture("containers-create.http"),
  start: () => fixture("containers-start.http"),
  wait: () => fixture("containers-wait.http"),
  /** A container that exited 0 — what a successful workspace preparation looks like. */
  waitZero: () => fixture("containers-wait-zero.http"),
  logs: () => fixture("containers-logs.http"),
  remove: () => fixture("containers-remove.http"),
  notFound: () => fixture("containers-notfound.http"),
  imageInspect: () => fixture("images-inspect.http"),
  volumeCreate: () => fixture("volumes-create.http"),
  volumeInspect: () => fixture("volumes-inspect.http"),
  volumeNotFound: () => fixture("volumes-notfound.http"),
  volumeRemove: () => fixture("volumes-remove.http"),
  /** `docker network create --internal maestro-egress` — the M26 shape. */
  networkInternal: () => fixture("networks-inspect-internal.http"),
  /** An ordinary bridge network: routes to the world without touching a proxy. */
  networkOpen: () => fixture("networks-inspect-open.http"),
  networkNotFound: () => fixture("networks-notfound.http"),
  /** Engine 29.4 refusing `SecurityOpt: seccomp=default` — see sandbox.ts. */
  badSeccompStart: () => fixture("containers-start-bad-seccomp.http"),
};

/** Container id inside `containers-create.http` (the recorded run). */
export const FIXTURE_CONTAINER_ID = (
  JSON.parse(Buffer.from(decodeResponse(FIXTURES.create()).body).toString("utf8")) as { Id: string }
).Id;

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}

export type Handler = (request: RecordedRequest) => Uint8Array | string | Promise<Uint8Array | string>;

export interface FakeTransport {
  transport: DockerTransport;
  requests: RecordedRequest[];
  /** Requests whose path contains `needle`. */
  matching(needle: string): RecordedRequest[];
}

export function fakeTransport(handler: Handler): FakeTransport {
  const requests: RecordedRequest[] = [];
  const transport: DockerTransport = {
    async exchange(bytes) {
      const request = parseRequest(bytes);
      requests.push(request);
      const answer = await handler(request);
      return typeof answer === "string" ? Buffer.from(answer, "utf8") : answer;
    },
  };
  return { transport, requests, matching: (needle) => requests.filter((r) => r.path.includes(needle)) };
}

function parseRequest(bytes: Uint8Array): RecordedRequest {
  const text = Buffer.from(bytes).toString("utf8");
  const [head = "", body = ""] = text.split("\r\n\r\n");
  const [statusLine = "", ...headerLines] = head.split("\r\n");
  const [method = "", path = ""] = statusLine.split(" ");
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { method, path, headers, ...(body.length > 0 ? { body } : {}) };
}

/** Synthesises a response for cases no fixture covers (500s, truncation…). */
export function httpResponse(
  status: number,
  body = "",
  options: { headers?: Record<string, string>; chunked?: boolean; omitLength?: boolean } = {},
): Uint8Array {
  const payloadBytes = Buffer.from(body, "utf8");
  const headers: Record<string, string> = { "Content-Type": "application/json", ...options.headers };
  let payload: Buffer;
  if (options.chunked) {
    headers["Transfer-Encoding"] = "chunked";
    payload = Buffer.concat([
      Buffer.from(`${payloadBytes.byteLength.toString(16)}\r\n`, "utf8"),
      payloadBytes,
      Buffer.from("\r\n0\r\n\r\n", "utf8"),
    ]);
  } else {
    if (!options.omitLength && headers["Content-Length"] === undefined) {
      headers["Content-Length"] = String(payloadBytes.byteLength);
    }
    payload = payloadBytes;
  }
  const head = [
    `HTTP/1.1 ${status} ${status === 204 ? "No Content" : "OK"}`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    "",
    "",
  ].join("\r\n");
  return Buffer.concat([Buffer.from(head, "utf8"), payload]);
}

/**
 * Routes the recorded fixtures by path, so a test only overrides what it cares
 * about. An override key is a path substring, optionally prefixed by a method
 * (`"DELETE /containers/"`).
 */
export function dockerRoutes(overrides: Partial<Record<string, Handler>> = {}): Handler {
  // The daemon answers `wait` per container; the fake has one recorded id for
  // every container, so it remembers whether the last thing CREATED was a
  // workspace-preparation container and answers its wait with the recorded
  // "exited 0". Without this the preparation would inherit the job fixture's
  // exit code 7 and every test would fail for the wrong reason.
  let preparing = false;
  return async (request) => {
    if (request.path.includes("/containers/create")) preparing = request.path.includes("-prep-");
    for (const [key, handler] of Object.entries(overrides)) {
      if (handler === undefined) continue;
      const [head = "", tail] = key.split(" ");
      const method = tail === undefined ? undefined : head;
      const needle = tail ?? head;
      if (method !== undefined && method !== request.method) continue;
      if (request.path.includes(needle)) return handler(request);
    }
    if (request.path === "/_ping") return FIXTURES.ping();
    if (request.path.includes("/containers/create")) return FIXTURES.create();
    if (request.path.includes("/start")) return FIXTURES.start();
    if (request.path.includes("/wait")) return preparing ? FIXTURES.waitZero() : FIXTURES.wait();
    if (request.path.includes("/logs")) return FIXTURES.logs();
    if (request.path.includes("/networks/")) return FIXTURES.networkInternal();
    if (request.path.includes("/volumes/create")) return FIXTURES.volumeCreate();
    if (request.method === "GET" && request.path.includes("/volumes/")) return FIXTURES.volumeNotFound();
    if (request.method === "DELETE" && request.path.includes("/volumes/")) return FIXTURES.volumeRemove();
    if (request.method === "DELETE" && request.path.includes("/containers/")) return FIXTURES.remove();
    if (request.path.includes("/images/")) return FIXTURES.imageInspect();
    return FIXTURES.notFound();
  };
}

export interface RunnerRig {
  runner: DockerLinuxRunner;
  requests: RecordedRequest[];
  matching: (needle: string) => RecordedRequest[];
  audit: AuditRecord[];
  timer: ManualTimer;
  clock: FakeClock;
}

/**
 * A driver wired to the recorded fixtures. Unless a test says otherwise the
 * workspace volume already exists AND already belongs to the sandbox uid, so no
 * preparation container runs and the test sees the job path alone; the
 * preparation path itself is nailed down in `provision.test.ts`.
 */
export function runnerRig(overrides: Partial<Record<string, Handler>> = {}, config: object = TEST_CONFIG): RunnerRig {
  const transport = fakeTransport(dockerRoutes({ "GET /volumes/": () => FIXTURES.volumeInspect(), ...overrides }));
  const clock = fakeClock();
  const timer = manualTimer();
  const audit: AuditRecord[] = [];
  const runner = createDockerLinuxRunner(config, {
    transport: transport.transport,
    clock: clock.clock,
    timer: timer.timer,
    newId: sequentialIds(),
    audit: (record) => audit.push(record),
  });
  return { runner, requests: transport.requests, matching: transport.matching, audit, timer, clock };
}

export interface FakeClock {
  clock: Clock;
  advance(milliseconds: number): void;
  set(iso: string): void;
}

export function fakeClock(startIso = "2026-08-08T14:20:00.000Z"): FakeClock {
  let current = Date.parse(startIso);
  return {
    clock: () => new Date(current),
    advance: (milliseconds) => {
      current += milliseconds;
    },
    set: (iso) => {
      current = Date.parse(iso);
    },
  };
}

export interface ManualTimer {
  timer: Timer;
  /** Fires every pending delay — i.e. "the timeout elapsed". */
  fire(): void;
  requested: number[];
  cancelled: number;
}

export function manualTimer(): ManualTimer {
  const pending: (() => void)[] = [];
  const state: ManualTimer = {
    requested: [],
    cancelled: 0,
    fire: () => {
      const waiting = pending.splice(0, pending.length);
      for (const resolve of waiting) resolve();
    },
    timer: (milliseconds) => {
      state.requested.push(milliseconds);
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      pending.push(resolve);
      return {
        promise,
        cancel: () => {
          state.cancelled += 1;
          const index = pending.indexOf(resolve);
          if (index >= 0) pending.splice(index, 1);
        },
      };
    },
  };
  return state;
}

/**
 * Yields to the event loop until `predicate` holds. Used to wait for the
 * driver to actually arm its timeout before the manual timer fires it — a
 * fixed number of microtask ticks would be a race dressed up as a test.
 */
export async function until(predicate: () => boolean, what: string, attempts = 1_000): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

export function sequentialIds(prefix = "lease"): IdSource {
  let counter = 0;
  return () => {
    counter += 1;
    return `${prefix}-0000000${counter}`;
  };
}

/** Digest-pinned image reference used across the tests (M27). */
export const TEST_IMAGE = "registry.internal.bank/maestro/node@sha256:".concat("a".repeat(64));

export const TEST_CONFIG = {
  platforms: { "linux-node": { image: TEST_IMAGE, capacity: 2 } },
  egress: { networkName: "maestro-egress", proxyUrl: "http://egress.internal.bank:3128" },
};

export const TEST_JOB = {
  runId: "run-2026-08-08-0001",
  workspaceKey: "UGURPAY-1042",
  command: ["/bin/sh", "-c", "npm test"],
  timeoutSeconds: 60,
};
