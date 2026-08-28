import { doc, paragraph } from "@maestro/adapter-jira";
import { AuditChain, InMemoryAuditStore } from "@maestro/audit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootPilot, type PilotStage } from "../src/boot.js";
import { cloudFixture, waitFor } from "./helpers.js";

/**
 * The ANALYSIS-APPROVAL hand-off (onay devri), end-to-end against a
 * FAKE-of-the-real Jira Cloud, entirely offline. When the analysis is complete
 * and its docs are attached, the pilot hands the ticket to the Analyst Manager:
 * reassign to the manager + move it into review ("İNCELEMEDE"). Then the gate is
 * resolved by polling — and here the manager REJECTS it.
 *
 * On /reject the pilot must: post a Turkish analysis-rejection note carrying the
 * reason, hand the ticket BACK to the Maestro Bot (for re-analysis), record a
 * GATE_REJECT + HANDOVER, and STOP THE FLOW CLEANLY — no code, no PR — WITHOUT
 * marking the run failed (a rejected analysis is a clean return, like İADE).
 */

const SITE = "https://uyildiz.atlassian.net";
const MANAGER = "712020:491aeb73-1111-2222-3333-444455556666";
const BOT = "712020:b836c135-7777-8888-9999-aaaabbbbcccc";
const REJECT_REASON = "kapsam eksik, ödeme iade akışı analizde yok";

// ------------------------------------------------------------- stub model

/** A complete intake + a valid analysis, so the flow reaches the analysis gate. */
function stubLlmFetch(_url: string, init?: RequestInit): Promise<Response> {
  const raw = typeof init?.body === "string" ? init.body : "";
  const body: unknown = JSON.parse(raw);
  const messages = (body as { messages: Array<{ content: string }> }).messages;
  const prompt = messages.map((message) => message.content).join("\n");

  let content: string;
  if (prompt.includes("Schema name: IntakeOutput")) {
    content = JSON.stringify({ complete: true, missing: [] });
  } else if (prompt.includes("Schema name: AnalysisDoc")) {
    content = JSON.stringify(analysisOutput);
  } else {
    content = "{}";
  }
  return Promise.resolve(
    new Response(
      JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 700, completion_tokens: 200 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}

const TICKET_KEY = "OPS-6";
const analysisOutput = {
  riskTier: "dusuk",
  riskReason: "Yüzey sınırlı olduğundan risk düşük değerlendirildi.",
  clarificationsUsed: [],
  sections: {
    purpose:
      "İşlem başarılı olduğunda müşteriye e-posta ile makbuz gönderilecek. Böylece şubeye gelen makbuz talepleri azalacak ve self-servis oranı artacak.",
    scope: { included: ["Makbuz üretimi", "E-posta gönderimi"], excluded: ["SMS makbuz"] },
    impactMatrix: [
      { appId: "ugurpay", impacted: true, summary: "Ödeme onay akışı makbuz e-postasını tetikler.", source: "primary_repo_discovery" },
    ],
    acceptanceCriteria: [
      "Başarılı işlemde makbuz e-posta ile gider.",
      "Başarısız işlemde makbuz gönderilmez.",
      "Makbuz gönderimi audit kaydına yazılır.",
    ],
    uiApiChanges: [{ Yüzey: "POST /payments/confirm", Durum: "değişti", "Geriye uyum": "geriye uyumlu" }],
    testApproach: "Birim testleri makbuz kurallarını doğrular. Entegrasyon testi e-posta tetiğini kontrol eder.",
    riskAndRollback: {
      risk: "Yanlış makbuz gönderimi müşteriyi yanıltabilir.",
      mitigation: "Doğrulama testleri ve gönderim öncesi kontrol eklenir.",
      rollback: "Özellik bayrağı kapatılır.",
    },
    sources: [
      { section: "purpose", claim: "e-posta makbuzu gönderilecek", kind: "ticket", ref: TICKET_KEY },
      { section: "scope", claim: "makbuz üretimi ve gönderimi", kind: "ticket", ref: TICKET_KEY },
      { section: "impactMatrix", claim: "ödeme akışı etkileniyor", kind: "ticket", ref: TICKET_KEY },
      { section: "acceptanceCriteria", claim: "başarılı işlemde makbuz gider", kind: "ticket", ref: TICKET_KEY },
      { section: "uiApiChanges", claim: "onay ucu makbuz tetikler", kind: "ticket", ref: TICKET_KEY },
      { section: "testApproach", claim: "makbuz kuralları test edilir", kind: "ticket", ref: TICKET_KEY },
      { section: "riskAndRollback", claim: "yanlış makbuz riski", kind: "ticket", ref: TICKET_KEY },
    ],
    openItems: [],
  },
};

// --------------------------------------------------- stateful fake Jira Cloud

function fakeJiraCloud(): {
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  comments: Array<{ id: string; body: unknown }>;
  assignments: Array<string | null>;
  transitions: string[];
} {
  const comments: Array<{ id: string; body: unknown }> = [];
  const assignments: Array<string | null> = [];
  const transitions: string[] = [];
  let nextId = 20000;
  let attachId = 10050;
  let labels: string[] = [];

  const transitionsPayload = {
    transitions: [
      { id: "31", name: "Başla", to: { id: "10010", name: "Devam Ediyor", statusCategory: { key: "indeterminate", name: "In Progress" } } },
      { id: "21", name: "İncelemeye al", to: { id: "10001", name: "İNCELEMEDE", statusCategory: { key: "indeterminate", name: "In Progress" } } },
      { id: "11", name: "Geri al", to: { id: "10000", name: "Yapılacaklar", statusCategory: { key: "new", name: "To Do" } } },
    ],
  };

  const issue = cloudFixture("issue-get") as { fields: Record<string, unknown> } & Record<string, unknown>;

  const group = cloudFixture("group-member-by-name");

  const json = (status: number, body: unknown): Response =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: body === undefined ? {} : { "content-type": "application/json" },
    });

  const fetchImpl = (rawUrl: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(rawUrl);
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const body: Record<string, unknown> = bodyText.length > 0 ? JSON.parse(bodyText) : {};

    if (path === "/rest/api/3/search/jql") return Promise.resolve(json(200, cloudFixture("search-jql")));
    if (path === "/rest/api/3/group/member") return Promise.resolve(json(200, group));

    if (path === "/rest/api/3/issue/OPS-6" && method === "GET") {
      if (url.searchParams.get("fields") === "labels") return Promise.resolve(json(200, { fields: { labels } }));
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
      return Promise.resolve(json(200, [{ id: String(attachId++) }]));
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
    // onay devri: reassign (→manager, then →bot on reject).
    if (path === "/rest/api/3/issue/OPS-6/assignee" && method === "PUT") {
      const accountId = body["accountId"];
      assignments.push(typeof accountId === "string" ? accountId : null);
      return Promise.resolve(json(204, undefined));
    }
    if (path === "/rest/api/3/issue/OPS-6/transitions" && method === "GET") {
      return Promise.resolve(json(200, transitionsPayload));
    }
    if (path === "/rest/api/3/issue/OPS-6/transitions" && method === "POST") {
      const transition = body["transition"] as { id?: string } | undefined;
      if (transition?.id) transitions.push(transition.id);
      return Promise.resolve(json(204, undefined));
    }
    // The poll source: Maestro's own comments plus the manager's standing
    // /reject <reason> — so the analysis gate REJECTS.
    if (path === "/rest/api/3/issue/OPS-6/comment" && method === "GET") {
      const reject = {
        id: String(nextId++), // her listelemede TAZE komut — kapı tabanı (stale-guard) eskisini eler
        author: { accountId: MANAGER },
        body: doc(paragraph(`/reject ${REJECT_REASON}`)),
        created: "2026-08-10T15:05:00.000+0300",
        updated: "2026-08-10T15:05:00.000+0300",
      };
      return Promise.resolve(json(200, { comments: [...comments.map((c) => ({ ...c, ...marker() })), reject] }));
    }

    throw new Error(`unexpected Jira Cloud call: ${method} ${path}`);
  };

  function marker(): { created: string; updated: string; author: { accountId: string } } {
    return {
      created: "2026-08-10T14:59:00.000+0300",
      updated: "2026-08-10T14:59:00.000+0300",
      author: { accountId: "maestro-app" },
    };
  }

  return { fetchImpl, comments, assignments, transitions };
}

describe("pilot analiz onay devri — yönetici reddederse ticket bota geri döner", () => {
  let stage: PilotStage;
  let jira: ReturnType<typeof fakeJiraCloud>;
  const auditStore = new InMemoryAuditStore();

  beforeAll(async () => {
    jira = fakeJiraCloud();
    stage = await bootPilot({
      audit: new AuditChain({ store: auditStore }),
      // The manager (approver) + bot (reassign target) seed the onay devri.
      env: { MAESTRO_MANAGER_ACCOUNT_ID: MANAGER, MAESTRO_BOT_ACCOUNT_ID: BOT },
      scm: "fake",
      uiPort: 0,
      adoPort: 0,
      openRouter: { apiKey: "test-key", baseUrl: "http://127.0.0.1:1" },
      jiraCloud: { baseUrl: SITE, email: "pilot@bank.example", apiToken: "api-token-123" },
      llmFetch: stubLlmFetch,
      jiraFetch: jira.fetchImpl,
      commandPollMs: 20,
    });
  });

  afterAll(async () => {
    await stage.close();
  });

  it("analiz onaya YÖNETİCİYE gider (atama + İNCELEMEDE); /reject gelince not yazılır ve ticket bota geri atanır", async () => {
    const running = stage.start("OPS-6");
    await waitFor(
      () => stage.store.snapshot().finished || stage.store.snapshot().failure !== null,
      30_000,
      "akış analiz-red ile durması",
    );
    await running;

    const state = stage.store.snapshot();
    // A rejected analysis is a CLEAN stop, not a failure.
    expect(state.failure).toBeNull();
    expect(state.finished).toBe(true);

    // ONAY DEVRİ: the ticket first went to the manager and into "İNCELEMEDE"
    // (transition 21, chosen by name), THEN — on reject — back to the bot.
    expect(jira.assignments[0]).toBe(MANAGER);
    expect(jira.assignments.at(-1)).toBe(BOT);
    expect(jira.transitions).toContain("21");

    // The analysis-rejection note (with the manager's reason) is on the ticket.
    const bodies = JSON.stringify(jira.comments.map((c) => c.body));
    expect(bodies).toContain("Analiz reddedildi");
    expect(bodies).toContain(REJECT_REASON);

    // The trail records: analysis review handover, a gate reject, and the
    // hand-back to the bot for re-analysis. No code/PR ever ran.
    const events = await auditStore.read();
    const handovers = events.filter((e) => e.action === "HANDOVER");
    expect(handovers.some((e) => e.meta["reason"] === "analysis_review")).toBe(true);
    const rejected = events.filter((e) => e.action === "GATE_REJECT" && e.meta["step"] === "5");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.meta["reason"]).toBe(REJECT_REASON);
    expect(handovers.some((e) => e.meta["reason"] === "analysis_rejected" && e.meta["reassigned"] === true)).toBe(true);
    expect(events.some((e) => e.action === "PR_OPENED")).toBe(false);
    expect(events.some((e) => e.action === "SECURITY_SCAN_PASS")).toBe(false);

    // The chain still verified.
    expect(state.audit.verified).toBe(true);
  }, 60_000);
});
