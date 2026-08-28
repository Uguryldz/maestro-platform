import type { AddressInfo } from "node:net";
import type { TicketKey } from "@maestro/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { DocStore } from "../src/docs.js";
import { GuidanceStore } from "../src/guidance.js";
import { close, listen } from "../src/http.js";
import { ListeningRulesStore } from "../src/listening.js";
import type { PilotRun } from "../src/run.js";
import { createUiServer } from "../src/server.js";
import { SettingsStore } from "../src/settings.js";
import type { PilotSettings } from "../src/settings.js";
import { initialState, StateStore } from "../src/state.js";
import { createPilotAudit } from "../src/wiring.js";

/**
 * `/api/start` carries the OPTIONAL, backwards-compatible STATUS HINT (the
 * selected discovery row's status) into the run so a STATUS listening rule can
 * classify the flow — and `/api/settings` calls the persistence hook after a
 * successful update, guarded so a persistence failure never fails the update.
 */

const stubRun = {} as unknown as PilotRun;

function boot(opts: {
  onStart?: (key: TicketKey, hint?: { status?: string }) => void;
  onSettingsChanged?: (s: PilotSettings) => void;
} = {}) {
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
  const server = createUiServer({
    store,
    settings,
    listening: new ListeningRulesStore(),
    guidance: new GuidanceStore(),
    run: stubRun,
    docs: new DocStore(),
    audit: createPilotAudit(),
    start: (key, hint) => {
      opts.onStart?.(key, hint);
      return Promise.resolve();
    },
    ...(opts.onSettingsChanged ? { onSettingsChanged: opts.onSettingsChanged } : {}),
  });
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

describe("POST /api/start — statü ipucu", () => {
  it("body'deki status start'a hint olarak taşınır", async () => {
    const calls: Array<{ key: string; hint?: { status?: string } }> = [];
    const { server } = boot({ onStart: (key, hint) => calls.push({ key, ...(hint ? { hint } : {}) }) });
    running = server;
    const url = await baseUrl(server);

    const res = await fetch(`${url}/api/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticketKey: "OPS-6", status: "Yapılacaklar" }),
    });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual([{ key: "OPS-6", hint: { status: "Yapılacaklar" } }]);
  });

  it("status olmadan eski davranış korunur (hint yok)", async () => {
    const calls: Array<{ key: string; hint?: { status?: string } }> = [];
    const { server } = boot({ onStart: (key, hint) => calls.push({ key, ...(hint ? { hint } : {}) }) });
    running = server;
    const url = await baseUrl(server);

    const res = await fetch(`${url}/api/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticketKey: "OPS-6" }),
    });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual([{ key: "OPS-6" }]);
  });
});

describe("POST /api/settings — kalıcılık kancası", () => {
  it("başarılı güncellemeden sonra onSettingsChanged yeni değerlerle çağrılır", async () => {
    const seen: PilotSettings[] = [];
    const { server } = boot({ onSettingsChanged: (s) => seen.push(s) });
    running = server;
    const url = await baseUrl(server);

    const res = await fetch(`${url}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandPollMs: 5_000, autoStart: false }),
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.commandPollMs).toBe(5_000);
    expect(seen[0]!.autoStart).toBe(false);
  });

  it("kanca patlasa bile güncelleme 200 döner ve store güncellenir", async () => {
    const { server, settings } = boot({
      onSettingsChanged: () => {
        throw new Error("disk dolu");
      },
    });
    running = server;
    const url = await baseUrl(server);

    const res = await fetch(`${url}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandPollMs: 7_000 }),
    });
    expect(res.status).toBe(200);
    expect(settings.snapshot().commandPollMs).toBe(7_000);
  });

  it("geçersiz güncellemede kanca HİÇ çağrılmaz", async () => {
    const seen: PilotSettings[] = [];
    const { server } = boot({ onSettingsChanged: (s) => seen.push(s) });
    running = server;
    const url = await baseUrl(server);

    const res = await fetch(`${url}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandPollMs: 0 }),
    });
    expect(res.status).toBe(400);
    expect(seen).toHaveLength(0);
  });
});
