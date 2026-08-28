import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootDemo, type DemoStage } from "../src/boot.js";
import { APPROVER, DEFAULT_DESCRIPTION } from "../src/config.js";
import { waitFor } from "./helpers.js";

/**
 * End-to-end test of the shortened flow, entirely offline: the two prop
 * servers are real HTTP servers on loopback and the model is a stub, so what
 * is exercised here is Maestro's own wiring — masking, gates, the CI signal,
 * the audit chain — with no network and no API spend.
 */

const outbound: string[] = [];

/** Stand-in for the OpenRouter chat-completions endpoint. */
function stubLlmFetch(_url: string, init?: RequestInit): Promise<Response> {
  const raw = typeof init?.body === "string" ? init.body : "";
  outbound.push(raw);
  const body: unknown = JSON.parse(raw);
  const messages = (body as { messages: Array<{ content: string }> }).messages;
  const prompt = messages.map((message) => message.content).join("\n");

  let content: string;
  if (prompt.includes("Schema name: IntakeVerdict")) {
    content = JSON.stringify({ complete: true, missing: [], note: "Ticket geliştirmeye uygun." });
  } else if (prompt.includes("Schema name: AnalysisDoc")) {
    content = JSON.stringify(analysisDoc);
  } else if (prompt.includes("Schema name: CodeDraft")) {
    content = JSON.stringify(codeDraft);
  } else {
    content = "{}";
  }
  return Promise.resolve(
    new Response(
      JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 900, completion_tokens: 300 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}

const analysisDoc = {
  templateVersion: "demo-v3",
  language: "tr",
  purpose: "Şifre sıfırlamada e-posta doğrulama adımı eklemek.",
  scope: { included: ["Doğrulama kodu üretimi", "Kod doğrulama"], excluded: ["SMS doğrulama"] },
  impactMatrix: [
    {
      appId: "ugurpay",
      impacted: true,
      summary: "Kimlik doğrulama akışı değişiyor.",
      source: "primary_repo_discovery",
    },
  ],
  acceptanceCriteria: ["Kod 10 dakika geçerli", "3 yanlış denemede kilit"],
  uiApiChanges: "POST /auth/reset/verify ucu eklenir.",
  testApproach: "Birim testleri ile kod doğrulama kuralları.",
  riskAndRollback: {
    risk: "Yanlış kilitleme",
    mitigation: "Deneme sayacı testleri",
    rollback: "Özellik bayrağı kapatılır",
  },
  riskTier: "dusuk",
  riskReason: "Sınırlı yüzey.",
  clarificationsUsed: [],
};

const codeDraft = {
  summary: "Doğrulama kodu kuralları için saf bir modül ve testi.",
  implementation: [
    "export function verifyResetCode(code, attempts) {",
    "  if (typeof code !== 'string' || !/^[0-9]{6}$/.test(code)) return 'gecersiz';",
    "  if (attempts >= 3) return 'kilitli';",
    "  return 'gecerli';",
    "}",
  ].join("\n"),
  test: [
    "import assert from 'node:assert/strict';",
    "import { verifyResetCode } from '../src/impl.mjs';",
    "assert.equal(verifyResetCode('123456', 0), 'gecerli');",
    "assert.equal(verifyResetCode('12', 0), 'gecersiz');",
    "assert.equal(verifyResetCode('123456', 3), 'kilitli');",
    "console.log('OK');",
  ].join("\n"),
};

describe("kısaltılmış akış uçtan uca", () => {
  let stage: DemoStage;

  beforeAll(async () => {
    stage = await bootDemo({
      uiPort: 0,
      jiraPort: 0,
      adoPort: 0,
      openRouter: { apiKey: "test-key", baseUrl: "http://127.0.0.1:1" },
      llmFetch: stubLlmFetch,
      buildDelayMs: 30,
      ciTimeoutMs: 15_000,
    });
  });

  afterAll(async () => {
    await stage.close();
  });

  it("iki /approve ile intake'ten merge'e kadar tamamlanır", async () => {
    const running = stage.start();

    await waitFor(() => stage.store.snapshot().awaitingGate === "3", 20_000, "analiz kapısı");
    await stage.jira.addHumanComment(APPROVER, "/approve");

    await waitFor(() => stage.store.snapshot().awaitingGate === "8", 30_000, "PR kapısı");
    await stage.jira.addHumanComment(APPROVER, "/approve");

    await running;

    const state = stage.store.snapshot();
    expect(state.failure).toBeNull();
    expect(state.finished).toBe(true);
    expect(state.steps.every((step) => step.state === "tamam")).toBe(true);

    // The chain really verified, and it really has records.
    expect(state.audit.verified).toBe(true);
    expect(state.audit.records).toBeGreaterThan(8);

    // The pull request exists on the ADO side and is merged.
    const pr = stage.ado.pullRequests().at(-1);
    expect(pr?.status).toBe("completed");

    // Jira carries the analysis comment and the closing comment.
    const bodies = stage.jira.state().comments.map((comment) => comment.body).join("\n");
    expect(bodies).toContain("Analiz hazır");
    expect(bodies).toContain("Tamamlandı");
  }, 90_000);

  it("kişisel veri modele maskesiz gitmedi", () => {
    expect(outbound.length).toBeGreaterThan(0);
    const sent = outbound.join("\n");
    expect(DEFAULT_DESCRIPTION).toContain("ayse.kaya@bank.example");
    expect(sent).not.toContain("ayse.kaya@bank.example");
    expect(sent).not.toContain("0532 111 22 33");
    expect(stage.store.snapshot().maskedFields).toBeGreaterThan(0);
  });
});
