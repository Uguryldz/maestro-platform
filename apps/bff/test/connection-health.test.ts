import { describe, expect, it } from "vitest";
import { connectionHealthReader, compositeHealthReader } from "../src/connection-health.js";
import type { ConnectionRecord } from "../src/connection-store.js";
import { InMemoryConnectionStore, InMemorySecretStore } from "../src/stores/connection-memory.js";
import type { HealthReader } from "../src/read-models.js";

/**
 * The rehearsal defect, closed: `/studio/health` must report the LLM and Jira
 * connections with three honest states — and must NOT dial the provider on
 * every poll when a fresh verdict already sits on the connection row.
 */

const NOW = new Date("2026-08-21T10:00:00.000Z");

const record = (over: Partial<ConnectionRecord>): ConnectionRecord => ({
  id: "conn-1",
  kind: "openrouter",
  displayName: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
  authKind: "bearer",
  config: {},
  secretRef: "connector:conn-1:abc",
  secretMask: "sk-4",
  enabled: true,
  onPrem: false,
  isDefault: true,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  lastTestedAt: null,
  lastTestOk: null,
  lastTestNote: null,
  ...over,
});

interface Fetches {
  calls: string[];
}

/** A stub target: counts what was dialled and answers what the test says. */
const stubFetch = (status: number): { fetchImpl: (url: string) => Promise<Response>; fetches: Fetches } => {
  const fetches: Fetches = { calls: [] };
  return {
    fetches,
    fetchImpl: (url: string) => {
      fetches.calls.push(url);
      return Promise.resolve(new Response("{}", { status }));
    },
  };
};

const makeReader = (
  rows: readonly ConnectionRecord[],
  status = 200,
): { reader: HealthReader; store: InMemoryConnectionStore; fetches: Fetches } => {
  const store = new InMemoryConnectionStore(rows);
  const secrets = new InMemorySecretStore();
  void secrets.set("connector:conn-1:abc", "sk-or-live-token");
  const { fetchImpl, fetches } = stubFetch(status);
  const reader = connectionHealthReader({ store, secrets, fetchImpl, now: () => NOW });
  return { reader, store, fetches };
};

describe("connectionHealthReader — three honest states", () => {
  it("no connection at all → every family reads not_configured, nothing is dialled", async () => {
    const { reader, fetches } = makeReader([]);

    const services = await reader.services();

    expect(services.map((s) => [s.service, s.state])).toEqual([
      ["llm", "not_configured"],
      ["jira", "not_configured"],
      ["scm", "not_configured"],
    ]);
    expect(services[0]?.note).toBe("health.note.not_configured");
    expect(fetches.calls).toEqual([]);
  });

  it("a disabled connection is not a configuration", async () => {
    const { reader } = makeReader([record({ enabled: false })]);
    const llm = (await reader.services()).find((s) => s.service === "llm");
    expect(llm?.state).toBe("not_configured");
  });

  it("a never-tested connection is probed once and reads healthy on a 200", async () => {
    const { reader, store, fetches } = makeReader([record({})]);

    const llm = (await reader.services()).find((s) => s.service === "llm");

    expect(llm?.state).toBe("healthy");
    expect(fetches.calls).toHaveLength(1);
    // The verdict is written back to the SAME row the connections panel
    // shows, so the two screens cannot disagree about the last test.
    const row = await store.get("conn-1");
    expect(row?.lastTestOk).toBe(true);
    expect(row?.lastTestedAt).toBe(NOW.toISOString());
  });

  it("a rejected key reads down, with the catalog key saying why", async () => {
    const { reader } = makeReader([record({})], 403);
    const llm = (await reader.services()).find((s) => s.service === "llm");
    expect(llm?.state).toBe("down");
    expect(llm?.note).toBe("connections.test.http_error");
  });
});

describe("connectionHealthReader — no probe storm", () => {
  it("a fresh cached verdict is served WITHOUT touching the provider", async () => {
    const { reader, fetches } = makeReader([
      record({
        // Two minutes old — inside the five-minute TTL.
        lastTestedAt: new Date(NOW.getTime() - 2 * 60_000).toISOString(),
        lastTestOk: false,
        lastTestNote: "connections.test.http_error",
      }),
    ]);

    const llm = (await reader.services()).find((s) => s.service === "llm");

    // The row's own verdict and its own timestamp, honestly.
    expect(llm?.state).toBe("down");
    expect(llm?.note).toBe("connections.test.http_error");
    expect(llm?.checkedAt).toBe(new Date(NOW.getTime() - 2 * 60_000).toISOString());
    // THE assertion this suite exists for: the health poll made no call.
    expect(fetches.calls).toEqual([]);
  });

  it("a stale verdict triggers exactly one probe, even across polls", async () => {
    const { reader, fetches } = makeReader([
      record({
        lastTestedAt: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
        lastTestOk: true,
        lastTestNote: "connections.test.ok",
      }),
    ]);

    // Two concurrent polls (the screen plus a second tab) share one probe...
    await Promise.all([reader.services(), reader.services()]);
    expect(fetches.calls).toHaveLength(1);

    // ...and the verdict just recorded is fresh for the polls that follow.
    await reader.services();
    expect(fetches.calls).toHaveLength(1);
  });
});

describe("compositeHealthReader", () => {
  it("lays connection rows beside the infrastructure probes", async () => {
    const infra: HealthReader = {
      services: () =>
        Promise.resolve([
          { service: "postgres", state: "healthy" as const, version: "16", checkedAt: NOW.toISOString(), note: null },
        ]),
    };
    const { reader } = makeReader([]);

    const services = await compositeHealthReader([infra, reader]).services();

    expect(services.map((s) => s.service)).toEqual(["postgres", "llm", "jira", "scm"]);
  });
});
