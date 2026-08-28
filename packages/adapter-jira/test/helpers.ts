import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFixture } from "@maestro/test-kit";
import { z } from "zod";
import type { FetchLike } from "../src/index.js";

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

/** Recorded-style Jira DC payloads; adapters validate them, tests never invent shapes inline. */
export function fixture(name: string): unknown {
  return loadFixture(FIXTURE_DIR, name, z.unknown());
}

export interface StubResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
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
  sleeps: number[];
  sleep: (ms: number) => Promise<void>;
}

/**
 * Offline fetch double: answers with the queued responses in order and fails
 * loudly on any unexpected call, so a stray request cannot pass unnoticed.
 */
export function stubFetch(responses: StubResponse[]): FetchStub {
  const calls: RecordedCall[] = [];
  const sleeps: number[] = [];
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

    const status = spec.status ?? 200;
    const hasBody = spec.body !== undefined;
    return Promise.resolve(
      new Response(hasBody ? JSON.stringify(spec.body) : null, {
        status,
        headers: { ...(hasBody ? { "content-type": "application/json" } : {}), ...(spec.headers ?? {}) },
      }),
    );
  };

  return {
    fetchImpl,
    calls,
    sleeps,
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };
}
