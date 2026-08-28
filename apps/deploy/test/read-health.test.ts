import { describe, expect, it } from "vitest";
import {
  httpProbe,
  postgresProbe,
  ProbeHealthReader,
  type ServiceProbe,
} from "../src/stores/read-health.js";

/**
 * The system-health probes (Sistem sağlığı screen / M6).
 *
 * The properties under test: an HTTP probe treats a reachable server (2xx–4xx)
 * as up and an unreachable one or a 5xx as down; the reader reports each probe's
 * real outcome, isolates one failure from the rest, and never lets a probe
 * failure take the page down.
 */

const FIXED_CLOCK = { now: () => new Date("2026-08-13T10:00:00.000Z") };

describe("httpProbe", () => {
  it("resolves (up) on a 2xx", async () => {
    const probe = httpProbe("pilot", "http://pilot/api/state", {
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });
    await expect(probe.check()).resolves.toBeUndefined();
  });

  it("resolves (up) on a 404 — the server is there, just no route", async () => {
    const probe = httpProbe("pilot", "http://pilot/api/state", {
      fetchImpl: async () => new Response("nope", { status: 404 }),
    });
    await expect(probe.check()).resolves.toBeUndefined();
  });

  it("rejects (down) on a 5xx", async () => {
    const probe = httpProbe("pilot", "http://pilot/api/state", {
      fetchImpl: async () => new Response("boom", { status: 503 }),
    });
    await expect(probe.check()).rejects.toThrow();
  });

  it("rejects (down) on a network error", async () => {
    const probe = httpProbe("pilot", "http://pilot/api/state", {
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(probe.check()).rejects.toThrow();
  });

  it("an AUTHENTICATED probe treats 401 as down (the token broke)", async () => {
    let seenAuth: string | null = null;
    const probe = httpProbe("jira", "http://jira/rest/api/3/myself", {
      headers: { authorization: "Basic abc" },
      fetchImpl: async (_url, init) => {
        seenAuth = (init?.headers as Record<string, string>)?.authorization ?? null;
        return new Response("unauthorized", { status: 401 });
      },
    });
    await expect(probe.check()).rejects.toThrow();
    // The auth header really reached the request.
    expect(seenAuth).toBe("Basic abc");
  });

  it("an authenticated probe is up on 200", async () => {
    const probe = httpProbe("jira", "http://jira/rest/api/3/myself", {
      headers: { authorization: "Basic abc" },
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });
    await expect(probe.check()).resolves.toBeUndefined();
  });

  it("authOptional treats 401 as up (server answered, just rejected us)", async () => {
    const probe = httpProbe("studio", "http://studio/", {
      authOptional: true,
      fetchImpl: async () => new Response("login", { status: 401 }),
    });
    await expect(probe.check()).resolves.toBeUndefined();
  });
});

describe("ProbeHealthReader", () => {
  it("reports a healthy service with its version and checkedAt", async () => {
    const up: ServiceProbe = { service: "postgres", version: "pg16", check: () => Promise.resolve() };
    const reader = new ProbeHealthReader([up], FIXED_CLOCK);
    const [row] = await reader.services();
    expect(row).toMatchObject({ service: "postgres", state: "healthy", version: "pg16", note: null });
    expect(row?.checkedAt).toBe("2026-08-13T10:00:00.000Z");
  });

  it("reports a failing service as down with a secret-free note", async () => {
    const down: ServiceProbe = {
      service: "pilot",
      version: "pilot",
      check: () => Promise.reject(new Error("connect to postgres://user:pass@host failed")),
    };
    const reader = new ProbeHealthReader([down], FIXED_CLOCK);
    const [row] = await reader.services();
    expect(row?.state).toBe("down");
    // The note must NOT carry the connection string.
    expect(row?.note).not.toContain("pass");
    expect(row?.note).not.toContain("host");
  });

  it("isolates one failure — a down probe does not hide a healthy one", async () => {
    const up: ServiceProbe = { service: "postgres", version: "pg", check: () => Promise.resolve() };
    const down: ServiceProbe = { service: "pilot", version: "p", check: () => Promise.reject(new Error("x")) };
    const reader = new ProbeHealthReader([up, down], FIXED_CLOCK);
    const rows = await reader.services();
    expect(rows.map((r) => `${r.service}:${r.state}`)).toEqual(["postgres:healthy", "pilot:down"]);
  });
});

describe("postgresProbe", () => {
  it("runs SELECT 1 against the pool", async () => {
    let ran = "";
    const probe = postgresProbe({
      $queryRawUnsafe: async <R = unknown>(q: string): Promise<R> => {
        ran = q;
        return [] as R;
      },
    });
    await probe.check();
    expect(ran).toBe("SELECT 1");
  });
});
