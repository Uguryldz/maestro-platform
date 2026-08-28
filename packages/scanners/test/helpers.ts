import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Clock, ContainerRunner, ContainerRunOutput, ContainerRunRequest, CoreScanTool, FetchLike } from "../src/index.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

/** Fixtures are read as raw text: a driver receives tool stdout, not an object. */
export function fixture(name: string): string {
  return readFileSync(join(FIXTURES, `${name}.json`), "utf8");
}

export const IMAGES: Record<CoreScanTool, string> = {
  gitleaks: `registry.bank.example:5000/security/gitleaks@sha256:${"1".repeat(64)}`,
  semgrep: `registry.bank.example:5000/security/semgrep@sha256:${"2".repeat(64)}`,
  trivy: `registry.bank.example:5000/security/trivy@sha256:${"3".repeat(64)}`,
};

export const WORKSPACE = { workspacePath: "/srv/maestro/ws/UGURPAY-500" };

export function configFor(tool: CoreScanTool, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    image: IMAGES[tool],
    ...(tool === "semgrep" ? { rulesRef: "/rules/bank-ruleset.yaml" } : {}),
    ...overrides,
  };
}

/** Deterministic clock: every call steps one second. */
export function fakeClock(startIso = "2026-08-08T10:00:00.000Z", stepMs = 1_000): Clock {
  let time = Date.parse(startIso);
  return () => {
    const now = new Date(time);
    time += stepMs;
    return now;
  };
}

export interface StubRunner {
  runner: ContainerRunner;
  requests: ContainerRunRequest[];
}

/** Queue of canned outputs; an `Error` entry makes the runner throw. */
export function stubRunner(...outputs: (Partial<ContainerRunOutput> | Error)[]): StubRunner {
  const requests: ContainerRunRequest[] = [];
  const queue = [...outputs];
  const runner: ContainerRunner = {
    async run(request) {
      requests.push(request);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...next };
    },
  };
  return { runner, requests };
}

export interface StubFetch {
  fetchImpl: FetchLike;
  calls: { url: string; init?: RequestInit }[];
}

export function stubFetch(...responses: ({ status?: number; body?: string } | Error)[]): StubFetch {
  const calls: { url: string; init?: RequestInit }[] = [];
  const queue = [...responses];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    const status = next?.status ?? 200;
    const body = next?.body ?? "{}";
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    } as Response;
  };
  return { fetchImpl, calls };
}
