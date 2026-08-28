import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchLike } from "@maestro/adapter-jira";
import { loadFixture } from "@maestro/test-kit";
import { z } from "zod";

/**
 * The recorded Jira Cloud fixtures live in the adapter-jira package (they were
 * captured from uyildiz.atlassian.net). The pilot's offline tests reuse them
 * verbatim rather than inventing shapes.
 */
const CLOUD_FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "adapter-jira",
  "fixtures",
  "cloud",
);

export function cloudFixture(name: string): unknown {
  return loadFixture(CLOUD_FIXTURE_DIR, name, z.unknown());
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
}

/**
 * Offline fetch double: answers with the queued responses in order and fails
 * loudly on any unexpected call, so a stray request cannot pass unnoticed.
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

    const status = spec.status ?? 200;
    const hasBody = spec.body !== undefined;
    return Promise.resolve(
      new Response(hasBody ? JSON.stringify(spec.body) : null, {
        status,
        headers: { ...(hasBody ? { "content-type": "application/json" } : {}), ...(spec.headers ?? {}) },
      }),
    );
  };

  return { fetchImpl, calls };
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
