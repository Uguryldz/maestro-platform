import { doc, paragraph } from "@maestro/adapter-jira";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootPilot, type PilotStage } from "../src/boot.js";
import type { ListeningRule } from "../src/listening.js";
import { cloudFixture } from "./helpers.js";

/**
 * RUN-TIME agent (variant) resolution — Faz 3 "akış → ajan eşlemesi".
 *
 * A listening rule maps its flow to a Studio-defined agent variant
 * (`analystVariantId`), and the RUN — not boot — resolves that variant's model
 * and persona. This proves the whole chain end to end, offline:
 *
 *   · the rule classifies OPS-6 (issuetype "Görev") as an `analiz` flow AND
 *     hands the run its agent mapping;
 *   · the run asks the variant store for `ozel-analist`'s model + persona AT RUN
 *     TIME (the boot only ever resolved the default variants);
 *   · the resolved MODEL is what the analyst/intake calls actually carry on the
 *     wire — a run-local gateway is built, no restart;
 *   · the resolved PERSONA shows up in the analyst's prompt;
 *   · the run log names the agent the flow ran with.
 *
 * The Jira transport is a minimal stateful stub of the live REST v3 routes the
 * `analiz` flow touches (read → comments → docs attach → review handover →
 * /approve gate), the model is a stub — nothing leaves the process.
 */

const OPERATOR = "712020:7ee7a2ab-23e7-47aa-a61e-38b79b7eb4d1";
const SITE = "https://uyildiz.atlassian.net";

const RULE: ListeningRule = {
  projectKey: "OPS",
  assigneeAccountId: "",
  matchKind: "issuetype",
  matchValue: "Görev", // the issue-get fixture's issue type
  flowType: "analiz", // analysis is the deliverable — no code/PR steps
  priority: 1,
  enabled: true,
  analystVariantId: "ozel-analist",
  engineerVariantId: "ozel-muhendis",
};

const ANALYST_MODEL = "acme/ozel-model";
const ANALYST_PERSONA = "ÖZEL ANALİST PERSONA: mobil senaryoları önce düşün.";

// ------------------------------------------------------------- stub model

const outbound: string[] = [];

const TICKET_KEY = "OPS-6";
const analysisOutput = {
  riskTier: "dusuk",
  riskReason: "Yüzey sınırlı olduğundan risk düşük değerlendirildi.",
  clarificationsUsed: [],
  sections: {
    purpose:
      "İşlem başarılı olduğunda müşteriye e-posta ile makbuz gönderilecek. Böylece şubeye gelen makbuz talepleri azalacak.",
    scope: { included: ["Makbuz üretimi", "E-posta gönderimi"], excluded: ["SMS makbuz", "mobil ekranlar"] },
    impactMatrix: [
      {
        appId: "ugurpay",
        impacted: true,
        summary: "Ödeme onay akışı makbuz e-postasını tetikler.",
        source: "primary_repo_discovery",
      },
    ],
    acceptanceCriteria: [
      "Başarılı işlemde makbuz e-posta ile gider.",
      "Başarısız işlemde makbuz gönderilmez.",
      "Makbuz gönderimi audit kaydına yazılır.",
    ],
    uiApiChanges: [
      { Yüzey: "POST /payments/confirm", Durum: "değişti", "Geriye uyum": "geriye uyumlu" },
    ],
    testApproach:
      "Birim testleri makbuz kurallarını doğrular. Entegrasyon testi e-posta tetiğini uçtan uca kontrol eder.",
    riskAndRollback: {
      risk: "Yanlış makbuz gönderimi müşteriyi yanıltabilir.",
      mitigation: "Doğrulama testleri eklenir.",
      rollback: "Özellik bayrağı kapatılır.",
    },
    sources: [
      { section: "purpose", claim: "e-posta makbuzu gönderilecek", kind: "ticket", ref: TICKET_KEY },
      { section: "scope", claim: "makbuz üretimi", kind: "ticket", ref: TICKET_KEY },
      { section: "impactMatrix", claim: "ödeme akışı etkileniyor", kind: "ticket", ref: TICKET_KEY },
      { section: "acceptanceCriteria", claim: "başarılı işlemde makbuz gider", kind: "ticket", ref: TICKET_KEY },
      { section: "uiApiChanges", claim: "onay ucu makbuz tetikler", kind: "ticket", ref: TICKET_KEY },
      { section: "testApproach", claim: "makbuz kuralları test edilir", kind: "ticket", ref: TICKET_KEY },
      { section: "riskAndRollback", claim: "yanlış makbuz riski", kind: "ticket", ref: TICKET_KEY },
    ],
    openItems: [],
  },
};

function stubLlmFetch(_url: string, init?: RequestInit): Promise<Response> {
  const raw = typeof init?.body === "string" ? init.body : "";
  outbound.push(raw);
  const prompt = raw;
  const content = prompt.includes("Schema name: IntakeOutput")
    ? JSON.stringify({ complete: true, missing: [] })
    : JSON.stringify(analysisOutput);
  return Promise.resolve(
    new Response(
      JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 500, completion_tokens: 200 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}

// --------------------------------------------------- minimal fake Jira Cloud

/** The REST v3 routes the `analiz` flow touches, stateful, offline. */
function fakeJiraCloud(): { fetchImpl: (url: string, init?: RequestInit) => Promise<Response> } {
  const comments: Array<{ id: string; body: unknown }> = [];
  let nextId = 20000;
  let attachId = 10050;
  let labels: string[] = [];

  const issue = cloudFixture("issue-get");
  const group = cloudFixture("group-member-by-name");

  const transitionsPayload = {
    transitions: [
      { id: "21", name: "İncelemeye al", to: { id: "10001", name: "İNCELEMEDE", statusCategory: { key: "indeterminate", name: "In Progress" } } },
      { id: "11", name: "Geri al", to: { id: "10000", name: "Yapılacaklar", statusCategory: { key: "new", name: "To Do" } } },
    ],
  };

  const json = (status: number, body: unknown): Response =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: body === undefined ? {} : { "content-type": "application/json" },
    });

  const marker = (): Record<string, unknown> => ({
    created: "2026-08-10T14:59:00.000+0300",
    updated: "2026-08-10T14:59:00.000+0300",
    author: { accountId: "maestro-app" },
  });

  const fetchImpl = (rawUrl: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(rawUrl);
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const body: Record<string, unknown> = bodyText.length > 0 ? JSON.parse(bodyText) : {};

    if (path === "/rest/api/3/group/member") return Promise.resolve(json(200, group));
    if (path === "/rest/api/3/issue/OPS-6" && method === "GET") {
      if (url.searchParams.get("fields") === "labels") {
        return Promise.resolve(json(200, { fields: { labels } }));
      }
      return Promise.resolve(json(200, issue));
    }
    if (path === "/rest/api/3/issue/OPS-6" && method === "PUT") {
      const update = body["update"] as { labels?: Array<Record<string, string>> } | undefined;
      for (const op of update?.labels ?? []) {
        if (op["add"]) labels = [...new Set([...labels, op["add"]])];
        if (op["remove"]) labels = labels.filter((l) => l !== op["remove"]);
      }
      return Promise.resolve(json(204, undefined));
    }
    if (path === "/rest/api/3/issue/OPS-6/attachments" && method === "POST") {
      return Promise.resolve(json(200, [{ id: String(attachId++), filename: "x", size: 1, mimeType: "application/pdf" }]));
    }
    if (path === "/rest/api/3/issue/OPS-6/comment" && method === "POST") {
      const id = String(nextId++);
      comments.push({ id, body: body["body"] });
      return Promise.resolve(json(201, { id }));
    }
    if (/^\/rest\/api\/3\/issue\/OPS-6\/comment\/\d+$/.test(path) && method === "PUT") {
      const id = path.split("/").pop() ?? "";
      const found = comments.find((c) => c.id === id);
      if (found) found.body = body["body"];
      return Promise.resolve(json(200, { id }));
    }
    if (path === "/rest/api/3/issue/OPS-6/transitions" && method === "GET") {
      return Promise.resolve(json(200, transitionsPayload));
    }
    if (path === "/rest/api/3/issue/OPS-6/transitions" && method === "POST") {
      return Promise.resolve(json(204, undefined));
    }
    if (path === "/rest/api/3/issue/OPS-6/comment" && method === "GET") {
      const approve = {
        id: String(nextId++), // her listelemede TAZE komut — kapı tabanı (stale-guard) eskisini eler
        author: { accountId: OPERATOR },
        body: doc(paragraph("/approve")),
        created: "2026-08-10T15:00:00.000+0300",
        updated: "2026-08-10T15:00:00.000+0300",
      };
      return Promise.resolve(json(200, { comments: [...comments.map((c) => ({ ...c, ...marker() })), approve] }));
    }

    throw new Error(`unexpected Jira Cloud call: ${method} ${path}`);
  };

  return { fetchImpl };
}

describe("run-time ajan (variant) çözümü — kural → ajan, restart'sız", () => {
  let stage: PilotStage;
  /** Every variantId the run (or boot) asked the store about, per method. */
  const modelCalls: string[] = [];
  const personaCalls: string[] = [];

  beforeAll(async () => {
    const jira = fakeJiraCloud();
    stage = await bootPilot({
      env: {}, // hermetic: no repo .env, no process.env leakage
      scm: "fake",
      uiPort: 0,
      adoPort: 0,
      openRouter: { apiKey: "test-key", baseUrl: "http://127.0.0.1:1" },
      jiraCloud: { baseUrl: SITE, email: "pilot@bank.example", apiToken: "api-token-123" },
      llmFetch: stubLlmFetch,
      jiraFetch: jira.fetchImpl,
      commandPollMs: 20,
      // The rule that maps this flow to the Studio agent "ozel-analist".
      listening: [RULE],
      // The variant store: only the rule-mapped analyst variant has a published
      // model+persona; every other id (the defaults at boot, the engineer
      // variant) answers null and falls back — so any "ozel-analist" hit below
      // can only have come from the RUN-TIME resolution.
      variantReader: {
        activeModel: (variantId: string) => {
          modelCalls.push(variantId);
          return Promise.resolve(variantId === "ozel-analist" ? ANALYST_MODEL : null);
        },
        activePersona: (variantId: string) => {
          personaCalls.push(variantId);
          return Promise.resolve(variantId === "ozel-analist" ? ANALYST_PERSONA : null);
        },
      },
    });
  });

  afterAll(async () => {
    await stage.close();
  });

  it("kuralın analystVariantId'si RUN sırasında çözülür ve akış o ajanla koşar", async () => {
    // Boot only resolved the DEFAULT variants — the rule's agent is untouched.
    expect(modelCalls).not.toContain("ozel-analist");

    await stage.start("OPS-6");

    const state = stage.store.snapshot();
    expect(state.failure).toBeNull();
    expect(state.finished).toBe(true);
    // The rule classified the flow…
    expect(state.flowType).toBe("analiz");

    // …and the RUN asked the variant store for the rule's agents (model AND
    // persona), not just the defaults.
    expect(modelCalls).toContain("ozel-analist");
    expect(modelCalls).toContain("ozel-muhendis");
    expect(personaCalls).toContain("ozel-analist");

    // The log names the agent the flow ran with.
    const log = state.log.map((l) => l.text).join("\n");
    expect(log).toContain(`🤖 analiz ajanı: ozel-analist (model ${ANALYST_MODEL})`);
    expect(log).toContain("🤖 mühendis ajanı: ozel-muhendis");
  });

  it("çözülen MODEL bu run'ın çağrılarında kullanıldı (restart yok)", () => {
    // Every LLM call this run made (intake + analyst) went out on the wire with
    // the variant's model — the run-local gateway, not the boot binding.
    expect(outbound.length).toBeGreaterThan(0);
    for (const raw of outbound) {
      const body = JSON.parse(raw) as { model?: string };
      expect(body.model).toBe(ANALYST_MODEL);
    }
  });

  it("çözülen PERSONA analist prompt'unda görünür", () => {
    const analystCalls = outbound.filter((b) => b.includes("Schema name: AnalysisDoc"));
    expect(analystCalls.length).toBeGreaterThan(0);
    expect(analystCalls.join("\n")).toContain("mobil senaryoları önce düşün");
  });
});
