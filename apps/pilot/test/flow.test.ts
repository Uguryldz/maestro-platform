import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { doc, paragraph } from "@maestro/adapter-jira";
import { AuditChain, InMemoryAuditStore } from "@maestro/audit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootPilot, type PilotStage } from "../src/boot.js";
import { APPROVER_GROUP } from "../src/config.js";
import { cloudFixture, waitFor } from "./helpers.js";

/**
 * End-to-end test of the shortened flow against a FAKE-of-the-real Jira Cloud,
 * entirely offline. The Jira transport is a stateful stub that answers the same
 * REST v3 routes the live site does (shaped by the recorded fixtures), the ADO
 * prop is a real loopback server, and the model is a stub — so what is
 * exercised is the pilot's own wiring: the poll-based gates, masking, the CI
 * signal, and the audit chain. No network, no API spend, no live Jira.
 */

const OPERATOR = "712020:7ee7a2ab-23e7-47aa-a61e-38b79b7eb4d1";
const SITE = "https://uyildiz.atlassian.net";
/** The Analyst Manager (approver) the analysis is handed to — from bootstrap env. */
const MANAGER = "712020:491aeb73-1111-2222-3333-444455556666";
/** The Maestro Bot the ticket is reassigned BACK to on approve — from bootstrap env. */
const BOT = "712020:b836c135-7777-8888-9999-aaaabbbbcccc";

// PII on purpose: proves the analyst/engineer inputs are masked before they
// leave the machine, exactly as the demo does with its ticket description.
const PII_EMAIL = "pilot.kullanici@bank.example";
const PII_PHONE = "0532 111 22 33";

// -------------------------------------------------------------- stub model

const outbound: string[] = [];

function stubLlmFetch(_url: string, init?: RequestInit): Promise<Response> {
  const raw = typeof init?.body === "string" ? init.body : "";
  outbound.push(raw);
  const body: unknown = JSON.parse(raw);
  const messages = (body as { messages: Array<{ content: string }> }).messages;
  const prompt = messages.map((message) => message.content).join("\n");

  let content: string;
  if (prompt.includes("Schema name: IntakeOutput")) {
    content = JSON.stringify({ complete: true, missing: [] });
  } else if (prompt.includes("Schema name: AnalysisDoc")) {
    content = JSON.stringify(analysisOutput);
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

/**
 * The analyst's output in the REAL template's shape (M108): keyed by the
 * `kurumsal-analiz` template section keys, validated by agent-roles against the
 * generated schema AND the M109 source list. Every claim section carries a
 * source row pointing at the one reference the pilot's context actually holds
 * today — the ticket key — because with an empty knowledge pack a repo_file or
 * repo_card citation would be refused as a fabrication.
 */
const TICKET_KEY = "OPS-6";
const analysisOutput = {
  riskTier: "dusuk",
  riskReason: "Yüzey sınırlı olduğundan risk düşük değerlendirildi.",
  clarificationsUsed: [],
  sections: {
    purpose:
      "İşlem başarılı olduğunda müşteriye e-posta ile makbuz gönderilecek. Böylece şubeye gelen makbuz talepleri azalacak ve self-servis oranı artacak.",
    scope: {
      included: ["Makbuz üretimi", "E-posta gönderimi"],
      excluded: ["SMS makbuz", "mobil ekranlar"],
    },
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
      mitigation: "Doğrulama testleri ve gönderim öncesi kontrol eklenir.",
      rollback: "Özellik bayrağı kapatılır, makbuz tetiği devre dışı bırakılır.",
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

const codeDraft = {
  summary: "Makbuz kuralları için saf bir modül ve testi.",
  implementation: [
    "export function receiptFor(amount, ok) {",
    "  if (typeof amount !== 'number' || amount <= 0) return 'gecersiz';",
    "  return ok ? 'makbuz' : 'yok';",
    "}",
  ].join("\n"),
  test: [
    "import assert from 'node:assert/strict';",
    "import { receiptFor } from '../src/impl.mjs';",
    "assert.equal(receiptFor(100, true), 'makbuz');",
    "assert.equal(receiptFor(100, false), 'yok');",
    "assert.equal(receiptFor(0, true), 'gecersiz');",
    "console.log('OK');",
  ].join("\n"),
};

// --------------------------------------------------- stateful fake Jira Cloud

/**
 * A stub that answers the live REST v3 routes. It records the comments Maestro
 * writes (so the test can assert they were posted to "real" Jira) and always
 * serves an operator `/approve` comment, so BOTH poll-based gates resolve.
 */
function fakeJiraCloud(): {
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  comments: Array<{ id: string; body: unknown }>;
  attachments: Array<{ filename: string; contentType: string }>;
  assignments: Array<string | null>;
  transitions: string[];
} {
  const comments: Array<{ id: string; body: unknown }> = [];
  const attachments: Array<{ filename: string; contentType: string }> = [];
  // Every assignee PUT and applied transition, in order, so the test can assert
  // the analysis onay-devri (assign→manager, İNCELEMEDE) and the reassign-back
  // to the bot on approve.
  const assignments: Array<string | null> = [];
  const transitions: string[] = [];
  let nextId = 20000;
  let attachId = 10050;
  let labels: string[] = [];

  // A live-shaped transitions payload: the "İNCELEMEDE" edge is In Progress and
  // is NOT the only in-progress edge — a category-blind pick could land on the
  // wrong one, so name-first selection is what puts the ticket in review.
  const transitionsPayload = {
    transitions: [
      { id: "31", name: "Başla", to: { id: "10010", name: "Devam Ediyor", statusCategory: { key: "indeterminate", name: "In Progress" } } },
      { id: "21", name: "İncelemeye al", to: { id: "10001", name: "İNCELEMEDE", statusCategory: { key: "indeterminate", name: "In Progress" } } },
      { id: "11", name: "Geri al", to: { id: "10000", name: "Yapılacaklar", statusCategory: { key: "new", name: "To Do" } } },
    ],
  };

  const issue = cloudFixture("issue-get") as { fields: Record<string, unknown> } & Record<string, unknown>;
  // Inject PII into the description so masking has something real to remove.
  const issueWithPii = {
    ...issue,
    fields: {
      ...issue.fields,
      description: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: `İşlem başarılı olduğunda kullanıcıya e-posta ile makbuz gönderilsin. Pilot kullanıcı: ${PII_EMAIL}, telefon ${PII_PHONE}.`,
              },
            ],
          },
        ],
      },
    },
  };

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

    // Discovery search (bounded JQL).
    if (path === "/rest/api/3/search/jql") return Promise.resolve(json(200, cloudFixture("search-jql")));

    // Group membership check (gate authorisation).
    if (path === "/rest/api/3/group/member") return Promise.resolve(json(200, group));

    // Issue read: full snapshot, or just labels.
    if (path === "/rest/api/3/issue/OPS-6" && method === "GET") {
      if (url.searchParams.get("fields") === "labels") {
        return Promise.resolve(json(200, { fields: { labels } }));
      }
      return Promise.resolve(json(200, issueWithPii));
    }
    // Label diff update.
    if (path === "/rest/api/3/issue/OPS-6" && method === "PUT") {
      const update = body["update"] as { labels?: Array<Record<string, string>> } | undefined;
      for (const op of update?.labels ?? []) {
        if (op["add"]) labels = [...new Set([...labels, op["add"]])];
        if (op["remove"]) labels = labels.filter((l) => l !== op["remove"]);
      }
      return Promise.resolve(json(204, undefined));
    }
    // Attachment upload (M103r): multipart/form-data, no JSON body. Record the
    // file so the test can assert both analysis docs landed on the ticket.
    if (path === "/rest/api/3/issue/OPS-6/attachments" && method === "POST") {
      const form = init?.body;
      if (!(form instanceof FormData)) throw new Error("attachment POST body must be FormData");
      const file = form.get("file");
      if (!(file instanceof Blob)) throw new Error("attachment POST missing file part");
      const filename = file instanceof File ? file.name : "unknown";
      attachments.push({ filename, contentType: file.type });
      const id = String(attachId++);
      return Promise.resolve(json(200, [{ id, filename, size: file.size, mimeType: file.type }]));
    }
    // Comment create.
    if (path === "/rest/api/3/issue/OPS-6/comment" && method === "POST") {
      const id = String(nextId++);
      comments.push({ id, body: body["body"] });
      return Promise.resolve(json(201, { id }));
    }
    // Comment update (progress edit, M75).
    if (/^\/rest\/api\/3\/issue\/OPS-6\/comment\/\d+$/.test(path) && method === "PUT") {
      const id = path.split("/").pop() ?? "";
      const found = comments.find((c) => c.id === id);
      if (found) found.body = body["body"];
      return Promise.resolve(json(200, { id }));
    }
    // Assignee PUT (onay devri: assign→manager, then reassign→bot on approve).
    if (path === "/rest/api/3/issue/OPS-6/assignee" && method === "PUT") {
      const accountId = body["accountId"];
      assignments.push(typeof accountId === "string" ? accountId : null);
      return Promise.resolve(json(204, undefined));
    }
    // Available transitions (with destination categories).
    if (path === "/rest/api/3/issue/OPS-6/transitions" && method === "GET") {
      return Promise.resolve(json(200, transitionsPayload));
    }
    // Apply the chosen transition (İNCELEMEDE on the handover).
    if (path === "/rest/api/3/issue/OPS-6/transitions" && method === "POST") {
      const transition = body["transition"] as { id?: string } | undefined;
      if (transition?.id) transitions.push(transition.id);
      return Promise.resolve(json(204, undefined));
    }
    // Comment list (the poll source): Maestro's own comments plus the standing
    // operator /approve. A fresh `seen` set per gate lets both gates pick it up.
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

  // Maestro's own comments are never commands (they lack a top-level /command),
  // so they need no created/updated to be skipped — but the parser reads them,
  // so give them timestamps to stay well-formed.
  function marker(): { created: string; updated: string; author: { accountId: string } } {
    return {
      created: "2026-08-10T14:59:00.000+0300",
      updated: "2026-08-10T14:59:00.000+0300",
      author: { accountId: "maestro-app" },
    };
  }

  return { fetchImpl, comments, attachments, assignments, transitions };
}

describe("pilot kısaltılmış akış — canlı Jira'ya karşı (offline stub)", () => {
  let stage: PilotStage;
  let jira: ReturnType<typeof fakeJiraCloud>;
  // The SAME chain the run appends through, so the test can read the trail back
  // and assert the sandbox events (M60). InMemoryAuditStore.read() enumerates.
  const auditStore = new InMemoryAuditStore();
  // The PERMANENT sandbox KÖK this run's workspace opens its ISOLATED ticket
  // subdir under (persistent-root model). Set from the UI settings store (env
  // only seeds the default), so this drives the real run.ts → createWorkspace
  // persistent-root wiring, not the mkdtemp fallback.
  let sandboxRoot: string;

  beforeAll(async () => {
    jira = fakeJiraCloud();
    sandboxRoot = await mkdtemp(join(tmpdir(), "maestro-flow-sandbox-"));
    stage = await bootPilot({
      audit: new AuditChain({ store: auditStore }),
      // Inject an authoritative env so this boot is fully hermetic: maestro/.env
      // is not read and process.env is ignored for every env-derived decision.
      // The manager + bot account ids seed the analysis onay-devri (assign→manager
      // + İNCELEMEDE, then reassign→bot on approve). With the SCM mode absent the
      // resolve falls to `fake` regardless of a developer's shell — so a polluted
      // PILOT_SCM=github can never send this "offline" test to real GitHub.
      // `scm: "fake"` is kept as belt-and-braces.
      env: { MAESTRO_MANAGER_ACCOUNT_ID: MANAGER, MAESTRO_BOT_ACCOUNT_ID: BOT },
      scm: "fake",
      uiPort: 0,
      adoPort: 0,
      openRouter: { apiKey: "test-key", baseUrl: "http://127.0.0.1:1" },
      jiraCloud: { baseUrl: SITE, email: "pilot@bank.example", apiToken: "api-token-123" },
      llmFetch: stubLlmFetch,
      jiraFetch: jira.fetchImpl,
      buildDelayMs: 30,
      ciTimeoutMs: 15_000,
      commandPollMs: 20,
      // Seed the knowledge library so this run proves uploaded house rules reach
      // BOTH the analyst and the engineer (Adım 1: belge → mühendis ajan).
      guidance: [{ title: "Kodlama standardı", content: "Parametreli sorgu kullan." }],
      // A variant reader that returns a Studio-configured PERSONA for each role,
      // so this run proves the persona reaches both the analyst and the engineer
      // (ajana persona bağı).
      variantReader: {
        activeModel: () => Promise.resolve(null),
        activePersona: (variantId: string) =>
          Promise.resolve(
            variantId.includes("engineer")
              ? "MÜHENDİS PERSONA: küçük ve okunur kod yaz."
              : "ANALİST PERSONA: riskleri önce yaz.",
          ),
      },
    });
    // Turn on the persistent sandbox root FROM THE SETTINGS STORE (as the UI
    // would), before any run: the workspace now opens <root>/OPS-6 and disposes
    // only that subdir, leaving the root standing.
    stage.settings.update({ sandboxRoot });
  });

  afterAll(async () => {
    await stage.close();
    await rm(sandboxRoot, { recursive: true, force: true });
  });

  it("keşif, canlı arama sonucundan maestro ticket'larını getirir", async () => {
    await stage.refreshDiscovery();
    const rows = stage.store.snapshot().discovered;
    expect(rows.length).toBe(6);
    expect(rows[0]!.key).toBe("OPS-6");
  });

  it("iki /approve (canlı Jira yorumu yoklanarak) ile intake'ten merge'e tamamlanır", async () => {
    const running = stage.start("OPS-6");

    // The gates resolve purely from the polled /approve — there is no local
    // box. A gate can open and close between samples, so the predicate also
    // accepts a terminal state (the run reaching the NEXT gate, finishing, or
    // failing) rather than only the transient awaitingGate value.
    const reached = (gate: string): boolean => {
      const s = stage.store.snapshot();
      return s.awaitingGate === gate || s.finished || s.failure !== null;
    };
    await waitFor(() => reached("3"), 20_000, "analiz kapısı");
    await waitFor(() => reached("8"), 30_000, "PR kapısı");

    await running;

    const state = stage.store.snapshot();
    expect(state.failure).toBeNull();
    expect(state.finished).toBe(true);
    expect(state.steps.every((step) => step.state === "tamam")).toBe(true);
    expect(state.browseUrl).toBe(`${SITE}/browse/OPS-6`);
    expect(state.approverGroup).toBe(APPROVER_GROUP);

    // The chain really verified and has records.
    expect(state.audit.verified).toBe(true);
    expect(state.audit.records).toBeGreaterThan(8);

    // M60: the run bracketed its workspace with exactly one SANDBOX_CREATE and
    // one SANDBOX_DESTROY, in that order, in the shape the Studio sandbox screen
    // folds — subject "<ticket> · <runner>", meta { ticketKey, runner }. This is
    // what makes the run's workspace show up (and then read as resumable) there.
    const events = await auditStore.read();
    const sandboxEvents = events.filter(
      (e) => e.action === "SANDBOX_CREATE" || e.action === "SANDBOX_DESTROY",
    );
    expect(sandboxEvents.map((e) => e.action)).toEqual(["SANDBOX_CREATE", "SANDBOX_DESTROY"]);
    for (const event of sandboxEvents) {
      expect(event.subject).toBe("OPS-6 · pilot-local");
      expect(event.meta["ticketKey"]).toBe("OPS-6");
      expect(event.meta["runner"]).toBe("pilot-local");
      expect(event.actor).toBe("maestro-runner");
    }

    // ONAY DEVRİ (analysis approval hand-off): before the analysis gate opened,
    // the ticket was reassigned to the Analyst Manager and moved to "İNCELEMEDE"
    // (transition 21 — the review edge, chosen by NAME even though a To-Do and a
    // "Devam Ediyor" edge were also on offer). On /approve it was reassigned BACK
    // to the Maestro Bot for the code step. So the assignee sequence begins
    // MANAGER → BOT, and the İNCELEMEDE transition was applied.
    expect(jira.assignments[0]).toBe(MANAGER);
    expect(jira.assignments).toContain(BOT);
    expect(jira.assignments.indexOf(MANAGER)).toBeLessThan(jira.assignments.indexOf(BOT));
    expect(jira.transitions).toContain("21");

    // The trail carries the handover both ways: a HANDOVER to review (assigned +
    // İNCELEMEDE) and a HANDOVER back to the bot on approval.
    const handovers = events.filter((e) => e.action === "HANDOVER");
    const toReview = handovers.find((e) => e.meta["reason"] === "analysis_review");
    expect(toReview?.meta).toMatchObject({ reassigned: true, transitioned: true, toStatus: "İNCELEMEDE" });
    const backToBot = handovers.find((e) => e.meta["reason"] === "analysis_approved");
    expect(backToBot?.meta).toMatchObject({ reassigned: true });

    // Persistent-KÖK model: the run opened its workspace as an ISOLATED subdir
    // under the permanent sandbox root, and on teardown disposed ONLY that
    // subdir — the KÖK itself is never torn down. So after the finished run the
    // root still stands and OPS-6's subdir is gone (dispose removed it, not the
    // root). This proves the SANDBOX_CREATE/DESTROY events above bracket a real
    // persistent-root workspace, not a mkdtemp one.
    const exists = async (path: string): Promise<boolean> => {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    };
    expect(await exists(sandboxRoot)).toBe(true);
    expect(await exists(join(sandboxRoot, "OPS-6"))).toBe(false);

    // The PR exists on the ADO side and is merged.
    const pr = stage.ado.pullRequests().at(-1);
    expect(pr?.status).toBe("completed");

    // Maestro's comments really went to (fake) real Jira.
    const bodies = JSON.stringify(jira.comments.map((c) => c.body));
    expect(bodies).toContain("Analiz hazır");
    expect(bodies).toContain("Tamamlandı");
    // The progress comment was edited in place (M75), not duplicated.
    expect(bodies).toContain("tamamlandı — PR birleşti");

    // M103r: the analysis Word + PDF were attached to the ticket automatically —
    // both files, with the right names and content types, no human drag-and-drop.
    expect(jira.attachments.map((a) => a.filename).sort()).toEqual(["OPS-6-analiz.docx", "OPS-6-analiz.pdf"]);
    const byName = new Map(jira.attachments.map((a) => [a.filename, a.contentType]));
    expect(byName.get("OPS-6-analiz.docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(byName.get("OPS-6-analiz.pdf")).toBe("application/pdf");
  }, 90_000);

  it("kişisel veri modele maskesiz gitmedi", () => {
    expect(outbound.length).toBeGreaterThan(0);
    const sent = outbound.join("\n");
    expect(sent).not.toContain(PII_EMAIL);
    expect(sent).not.toContain(PII_PHONE);
    expect(stage.store.snapshot().maskedFields).toBeGreaterThan(0);
  });

  it("kurum bilgisi (öğren) hem analiste hem MÜHENDİSE ulaştı", () => {
    // The uploaded coding standard must appear in the ENGINEER call, not only
    // the analyst — so house rules bind the written code (Adım 1).
    const engineerCalls = outbound.filter((b) => b.includes("Schema name: CodeDraft"));
    expect(engineerCalls.length).toBeGreaterThan(0);
    expect(engineerCalls.join("\n")).toContain("Parametreli sorgu kullan");
    // And still reaches the analyst, as before.
    const analystCalls = outbound.filter((b) => b.includes("Schema name: AnalysisDoc"));
    expect(analystCalls.join("\n")).toContain("Parametreli sorgu kullan");
  });

  it("Studio persona'sı analiste ve mühendise ayrı ayrı ulaştı", () => {
    // The analyst variant's persona reaches the analyst call…
    const analystCalls = outbound.filter((b) => b.includes("Schema name: AnalysisDoc"));
    expect(analystCalls.join("\n")).toContain("ANALİST PERSONA: riskleri önce yaz.");
    // …and the engineer variant's persona reaches the engineer call.
    const engineerCalls = outbound.filter((b) => b.includes("Schema name: CodeDraft"));
    expect(engineerCalls.join("\n")).toContain("MÜHENDİS PERSONA: küçük ve okunur kod yaz.");
  });
});
