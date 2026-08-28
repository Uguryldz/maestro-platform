import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFixture } from "@maestro/test-kit";
import { z } from "zod";
import type { Clock, FetchLike } from "../src/index.js";

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

/** Recorded-style Vault payloads; tests never invent a response shape inline. */
export function fixture(name: string): unknown {
  return loadFixture(FIXTURE_DIR, name, z.unknown());
}

/** Secret material that appears in the fixtures — the leak tests hunt for these. */
export const SECRET_VALUES = [
  "s.JIRA-PAT-DEFAULT-FIELD-VALUE",
  "s.JIRA-PAT-NAMED-FIELD-VALUE",
  "ghs.SHORT-LIVED-PUSH-TOKEN",
  "hvs.CAESIJ-MAESTRO-CLIENT-TOKEN",
  "role-id-1234",
  "secret-id-5678",
] as const;

export const APPROLE = { roleId: "role-id-1234", secretId: "secret-id-5678" };

export interface StubResponse {
  status?: number;
  body?: unknown;
  /** Raw body text, for the malformed-JSON cases. */
  text?: string;
}

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FetchStub {
  fetchImpl: FetchLike;
  calls: RecordedCall[];
}

/**
 * Offline fetch double: answers the queued responses in order and throws on any
 * unexpected call, so a stray request can never pass unnoticed.
 */
export function stubFetch(responses: StubResponse[]): FetchStub {
  const calls: RecordedCall[] = [];
  let index = 0;

  const fetchImpl: FetchLike = (url, init) => {
    const spec = responses[index];
    index += 1;
    if (!spec) throw new Error(`unexpected fetch call #${index}: ${init?.method ?? "GET"} ${url}`);

    calls.push({
      method: init?.method ?? "GET",
      url,
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      body: typeof init?.body === "string" && init.body.length > 0 ? JSON.parse(init.body) : undefined,
    });

    const hasBody = spec.body !== undefined || spec.text !== undefined;
    const payload = spec.text ?? (spec.body === undefined ? null : JSON.stringify(spec.body));
    return Promise.resolve(
      new Response(payload, {
        status: spec.status ?? 200,
        headers: hasBody ? { "content-type": "application/json" } : {},
      }),
    );
  };

  return { fetchImpl, calls };
}

export interface FakeClock {
  clock: Clock;
  advance(ms: number): void;
  now(): number;
}

/** 2026-08-08T09:00:00.000Z — a fixed instant keeps every expiry assertion exact. */
export const T0 = Date.UTC(2026, 7, 8, 9, 0, 0);

export function fakeClock(startMs: number = T0): FakeClock {
  let current = startMs;
  return {
    clock: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    now: () => current,
  };
}

/**
 * Runs `body` with a forced ambient `process.env.NODE_ENV` and always restores
 * it. The production gate reads the AMBIENT stage, so this is the only honest
 * way to test that a caller cannot talk it open.
 */
export function withAmbientNodeEnv<T>(value: string | undefined, body: () => T): T {
  const previous = process.env["NODE_ENV"];
  if (value === undefined) delete process.env["NODE_ENV"];
  else process.env["NODE_ENV"] = value;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env["NODE_ENV"];
    else process.env["NODE_ENV"] = previous;
  }
}

/** Recorded Azure DevOps project/repository names — the source of the B5 scopes. */
export function adoNames(): { projects: string[]; repos: string[] } {
  return loadFixture(
    FIXTURE_DIR,
    "ado-names",
    z.object({ projects: z.array(z.string()), repos: z.array(z.string()) }),
  );
}

export const VAULT_CONFIG = {
  addr: "https://vault.internal.bank",
  allowedMounts: ["kv", "git"],
  shortLived: { mount: "git", pathPrefix: "creds", field: "token", maxTtlSeconds: 900 },
};

export const ENV_FILE_CONFIG = {
  allowedMounts: ["kv", "git"],
};

/** Every Vault interaction starts with an AppRole login response. */
export function withLogin(responses: StubResponse[]): StubResponse[] {
  return [{ body: fixture("approle-login") }, ...responses];
}
