import { ListeningRulesStore } from "../src/listening.js";
import type { AddressInfo } from "node:net";
import type { AnalysisDoc } from "@maestro/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { analysisToDocs, DocStore } from "../src/docs.js";
import { close, listen } from "../src/http.js";
import type { PilotRun } from "../src/run.js";
import { createUiServer } from "../src/server.js";
import { createPilotAudit } from "../src/wiring.js";
import { GuidanceStore } from "../src/guidance.js";
import { SettingsStore } from "../src/settings.js";
import { initialState, StateStore } from "../src/state.js";

/**
 * The `/api/doc/:kind` download route, offline. It must 404 before the analysis
 * step generated anything, and once documents are stored it must stream the
 * right bytes with the right `Content-Type` and an attachment filename. The
 * `run` collaborator is never touched on this path, so a bare stub is honest.
 */

const TICKET = "OPS-7";
const RUN_ID = "pilot-20260810120000";

const ANALYSIS: AnalysisDoc = {
  templateVersion: "pilot-v3",
  language: "tr",
  purpose: "Kart limiti güncelleme akışı",
  scope: { included: ["ugurpay ödeme akışı"], excluded: [] },
  impactMatrix: [
    { appId: "ugurpay", impacted: true, summary: "Ödeme uç noktası değişir", source: "primary_repo_discovery" },
  ],
  acceptanceCriteria: ["Limit aşımı reddedilir"],
  uiApiChanges: "POST /odeme limit alanı",
  testApproach: "Birim ve sözleşme testleri",
  riskAndRollback: { risk: "Yanlış limit", mitigation: "Özellik bayrağı", rollback: "Bayrağı kapat" },
  riskTier: "orta",
  riskReason: "Ödeme akışını etkiler",
  clarificationsUsed: [],
};

const stubRun = {} as unknown as PilotRun;

function boot(docs: DocStore) {
  const store = new StateStore(
    initialState({ model: "stub", jiraSite: "https://example.atlassian.net", approverGroup: "g" }),
  );
  const settings = new SettingsStore({
    approverGroup: "g",
    model: "stub",
    commandPollMs: 3_000,
    discoveryPollMs: 15_000,
    dataClass: "gizli",
    operatorAccount: "op@corp",
    sandboxRoot: "",
    reviewStatusName: "İNCELEMEDE",
    autoMerge: false,
    autoStart: true,
  });
  const server = createUiServer({ store, settings, listening: new ListeningRulesStore(), guidance: new GuidanceStore(), run: stubRun, docs, audit: createPilotAudit(), start: () => Promise.resolve() });
  return { store, server };
}

let running: Awaited<ReturnType<typeof boot>>["server"] | null = null;

afterEach(async () => {
  if (running) await close(running);
  running = null;
});

async function baseUrl(server: NonNullable<typeof running>): Promise<string> {
  await listen(server, 0);
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

describe("GET /api/doc/:kind", () => {
  it("404s before the documents are generated", async () => {
    const { server } = boot(new DocStore());
    running = server;
    const url = await baseUrl(server);

    const res = await fetch(`${url}/api/doc/pdf`);
    expect(res.status).toBe(404);
  });

  it("404s for an unknown kind", async () => {
    const docs = new DocStore();
    docs.put(RUN_ID, await analysisToDocs(ANALYSIS, TICKET, RUN_ID));
    const { server } = boot(docs);
    running = server;
    const url = await baseUrl(server);

    const res = await fetch(`${url}/api/doc/xls`);
    expect(res.status).toBe(404);
  });

  it("streams the pdf with application/pdf and an attachment filename", async () => {
    const docs = new DocStore();
    docs.put(RUN_ID, await analysisToDocs(ANALYSIS, TICKET, RUN_ID));
    const { server } = boot(docs);
    running = server;
    const url = await baseUrl(server);

    const res = await fetch(`${url}/api/doc/pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain('filename="OPS-7-analiz.pdf"');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });

  it("streams the docx with the OOXML content type and a PK header", async () => {
    const docs = new DocStore();
    docs.put(RUN_ID, await analysisToDocs(ANALYSIS, TICKET, RUN_ID));
    const { server } = boot(docs);
    running = server;
    const url = await baseUrl(server);

    const res = await fetch(`${url}/api/doc/docx`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(res.headers.get("content-disposition")).toContain('filename="OPS-7-analiz.docx"');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.slice(0, 2))).toEqual([0x50, 0x4b]);
  });
});
