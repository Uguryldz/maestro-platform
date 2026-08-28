import { ListeningRulesStore } from "../src/listening.js";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DocStore } from "../src/docs.js";
import { close, listen } from "../src/http.js";
import type { PilotRun } from "../src/run.js";
import { createUiServer } from "../src/server.js";
import { createPilotAudit } from "../src/wiring.js";
import { GuidanceStore } from "../src/guidance.js";
import { SettingsStore } from "../src/settings.js";
import { initialState, StateStore } from "../src/state.js";

/**
 * The `/api/settings` routes, offline. GET returns the six current values and no
 * secret; POST validates and updates, returns 400 with a Turkish message on bad
 * input, and is REFUSED with 409 while a run is in progress (the mid-run guard).
 * The `run` collaborator is never touched on these paths, so a bare stub is honest.
 */

const stubRun = {} as unknown as PilotRun;

function boot() {
  const store = new StateStore(
    initialState({ model: "stub", jiraSite: "https://example.atlassian.net", approverGroup: "g" }),
  );
  const settings = new SettingsStore({
    approverGroup: "jira-users-uyildiz",
    model: "openai/gpt-4o-mini",
    commandPollMs: 3_000,
    discoveryPollMs: 15_000,
    dataClass: "gizli",
    operatorAccount: "op@corp",
    sandboxRoot: "",
    reviewStatusName: "İNCELEMEDE",
    autoMerge: false,
    autoStart: true,
  });
  const server = createUiServer({ store, settings, listening: new ListeningRulesStore(), guidance: new GuidanceStore(), run: stubRun, docs: new DocStore(), audit: createPilotAudit(), start: () => Promise.resolve() });
  return { store, settings, server };
}

let running: ReturnType<typeof boot>["server"] | null = null;

afterEach(async () => {
  if (running) await close(running);
  running = null;
});

async function baseUrl(server: NonNullable<typeof running>): Promise<string> {
  await listen(server, 0);
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

describe("GET /api/settings", () => {
  it("returns the current settable values and exposes no secret", async () => {
    const { server } = boot();
    running = server;
    const url = await baseUrl(server);

    const res = await fetch(`${url}/api/settings`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ["approverGroup", "commandPollMs", "dataClass", "discoveryPollMs", "model", "operatorAccount", "sandboxRoot", "reviewStatusName", "autoMerge", "autoStart"].sort(),
    );
    // No token/secret leaks through.
    for (const key of Object.keys(body)) {
      expect(key.toLowerCase()).not.toContain("token");
      expect(key.toLowerCase()).not.toContain("secret");
    }
  });
});

describe("POST /api/settings", () => {
  it("updates valid settings and returns the new values", async () => {
    const { settings, server } = boot();
    running = server;
    const url = await baseUrl(server);

    const res = await fetch(`${url}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandPollMs: 5_000, dataClass: "dahili" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.commandPollMs).toBe(5_000);
    expect(body.dataClass).toBe("dahili");
    // The store really changed.
    expect(settings.snapshot().commandPollMs).toBe(5_000);
  });

  it("rejects an invalid value with 400 and a Turkish message", async () => {
    const { settings, server } = boot();
    running = server;
    const url = await baseUrl(server);

    const res = await fetch(`${url}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandPollMs: 0 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(typeof body.error).toBe("string");
    expect(body.error?.length ?? 0).toBeGreaterThan(0);
    // Nothing was stored.
    expect(settings.snapshot().commandPollMs).toBe(3_000);
  });

  it("rejects a non-JSON body with 400", async () => {
    const { server } = boot();
    running = server;
    const url = await baseUrl(server);

    const res = await fetch(`${url}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("REFUSES a change while a run is in progress (409 mid-run guard)", async () => {
    const { store, settings, server } = boot();
    running = server;
    const url = await baseUrl(server);

    store.update((state) => {
      state.running = true;
    });

    const res = await fetch(`${url}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandPollMs: 5_000 }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("akış sürerken");
    // The store was not touched despite the valid payload.
    expect(settings.snapshot().commandPollMs).toBe(3_000);
  });
});
