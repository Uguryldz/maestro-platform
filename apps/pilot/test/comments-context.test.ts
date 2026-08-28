import type { GenerateObjectRequest, LlmCallLog, TicketSnapshot } from "@maestro/contracts";
import type { AgentSessionResult, LlmOutcome, LlmPort } from "@maestro/ports";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  appendCommentsToDescription,
  buildAnalysisContext,
  produceAnalysis,
  requestIntake,
  type TicketComment,
} from "../src/analysis.js";

/**
 * Clarify-resume lite (İADE döngüsünü kıran parça): the ticket's HUMAN comments
 * must reach BOTH the intake and the analyst. When a returned ticket's reporter
 * answers in a comment and the ticket is reassigned to the bot, the intake must
 * SEE the answer (appended to a CLONED snapshot's description) and the analyst
 * must receive it as a clarification round it can read and cite.
 */

const TICKET: TicketSnapshot = {
  key: "OPS-6",
  projectKey: "OPS",
  issueType: "Story",
  summary: "Ödeme onayında e-posta makbuzu",
  description: "İşlem başarılı olduğunda müşteriye makbuz e-postası gönderilsin.",
  reporter: "reporter@bank.example",
  assignee: null,
  components: ["payments"],
  labels: ["maestro"],
  parentKey: null,
  createdAt: "2026-08-10T12:00:00.000Z",
  updatedAt: "2026-08-10T12:00:00.000Z",
};

const COMMENTS: TicketComment[] = [
  { author: "reporter@bank.example", text: "Kabul kriteri: makbuz 1 dakika içinde gitsin." },
  { author: "po@bank.example", text: "Kapsam yalnız web; mobil hariç." },
];

const LOG: LlmCallLog = {
  at: "2026-08-10T12:00:00.000Z",
  runId: null,
  role: "analyst",
  variantId: "pilot-v1",
  driver: "openai-compat",
  model: "openai/gpt-4o-mini",
  tokensIn: 10,
  tokensOut: 5,
  cachePct: null,
  usd: null,
  dataClass: "gizli",
};

/** Records requests; answers with the given value(s), last one reused. */
function mockLlm(values: Array<Record<string, unknown>>): {
  llm: LlmPort;
  requests: GenerateObjectRequest[];
} {
  const requests: GenerateObjectRequest[] = [];
  let call = 0;
  const llm: LlmPort = {
    generateObject<T>(req: GenerateObjectRequest, _schema: z.ZodType<T>): Promise<LlmOutcome<T>> {
      requests.push(req);
      const value = values[Math.min(call, values.length - 1)];
      call += 1;
      return Promise.resolve({ status: "ok" as const, value: value as unknown as T, log: LOG });
    },
    agentSession(): Promise<LlmOutcome<AgentSessionResult>> {
      throw new Error("agentSession not used");
    },
  };
  return { llm, requests };
}

/** A template-valid analyst output that CITES the first comment round. */
function validOutput(): Record<string, unknown> {
  return {
    riskTier: "dusuk",
    riskReason: "Yüzey sınırlı olduğundan risk düşük değerlendirildi.",
    clarificationsUsed: [],
    sections: {
      purpose:
        "İşlem onayında müşteriye makbuz e-postası gönderilecek. Böylece manuel talepler azalacak.",
      scope: { included: ["Makbuz üretimi"], excluded: ["SMS makbuz"] },
      impactMatrix: [
        {
          appId: "ugurpay",
          impacted: true,
          summary: "Ödeme akışı makbuz e-postasını tetikler.",
          source: "primary_repo_discovery",
        },
      ],
      acceptanceCriteria: ["Makbuz gider.", "Hatada gitmez.", "Audit yazılır."],
      uiApiChanges: [{ Yüzey: "POST /pay", Durum: "değişti", "Geriye uyum": "geriye uyumlu" }],
      testApproach:
        "Birim testleri makbuz kurallarını doğrular. Entegrasyon testi tetiği kontrol eder.",
      riskAndRollback: {
        risk: "Yanlış makbuz müşteriyi yanıltabilir.",
        mitigation: "Doğrulama testleri eklenir.",
        rollback: "Özellik bayrağı kapatılır.",
      },
      sources: [
        // The analyst may cite a clarification round — comment rounds are real
        // references (their ids are in the reference index).
        { section: "purpose", claim: "süre kriteri", kind: "clarification", ref: "yorum-1" },
        { section: "scope", claim: "kapsam", kind: "ticket", ref: "OPS-6" },
        { section: "impactMatrix", claim: "etki", kind: "ticket", ref: "OPS-6" },
        { section: "acceptanceCriteria", claim: "kabul", kind: "ticket", ref: "OPS-6" },
        { section: "uiApiChanges", claim: "uç", kind: "ticket", ref: "OPS-6" },
        { section: "testApproach", claim: "test", kind: "ticket", ref: "OPS-6" },
        { section: "riskAndRollback", claim: "risk", kind: "ticket", ref: "OPS-6" },
      ],
      openItems: [],
    },
  };
}

describe("insan yorumları intake'e ulaşır (İADE döngüsü kırılır)", () => {
  it("appendCommentsToDescription: yorumlar açıklamaya blok olarak eklenir; yorum yoksa dokunulmaz", () => {
    const appended = appendCommentsToDescription(TICKET.description, COMMENTS);
    expect(appended).toContain(TICKET.description);
    expect(appended).toContain("--- Yorumlar");
    expect(appended).toContain("reporter@bank.example: Kabul kriteri: makbuz 1 dakika içinde gitsin.");
    expect(appendCommentsToDescription(TICKET.description, [])).toBe(TICKET.description);
  });

  it("requestIntake: yorumlar KLONLANMIŞ ticket açıklamasıyla intake prompt'una taşınır", async () => {
    const { llm, requests } = mockLlm([{ complete: true, missing: [] }]);
    await requestIntake({
      llm,
      ticket: TICKET,
      variantId: "pilot-v1",
      dataClass: "gizli",
      comments: COMMENTS,
    });

    expect(requests).toHaveLength(1);
    const input = String(requests[0]!.input);
    // Both human answers reached the intake role's prompt.
    expect(input).toContain("Kabul kriteri: makbuz 1 dakika içinde gitsin.");
    expect(input).toContain("Kapsam yalnız web; mobil hariç.");
    // The ORIGINAL snapshot was cloned, never mutated (contract stays frozen).
    expect(TICKET.description).not.toContain("Yorumlar");
  });

  it("buildAnalysisContext: yorumlar clarification turlarına eşlenir (id'leri atıfa açık)", () => {
    const context = buildAnalysisContext(TICKET, [], [], COMMENTS);
    expect(context.clarifications).toHaveLength(2);
    expect(context.clarifications[0]).toEqual({
      id: "yorum-1",
      question: "Ticket yorumu (reporter@bank.example)",
      answer: "Kabul kriteri: makbuz 1 dakika içinde gitsin.",
    });
  });

  it("produceAnalysis: yorumlar analist prompt'unda görünür ve 'yorum-1' atfı fabrikasyon sayılmaz", async () => {
    const { llm, requests } = mockLlm([validOutput()]);
    const result = await produceAnalysis({
      llm,
      ticket: TICKET,
      variantId: "pilot-v1",
      dataClass: "gizli",
      comments: COMMENTS,
    });

    // The prompt carries the clarification rounds (the human answers).
    const input = String(requests[0]!.input);
    expect(input).toContain("Kabul kriteri: makbuz 1 dakika içinde gitsin.");
    // And the analysis validated: the clarification citation was accepted
    // (an unknown ref would have been refused fail-closed as a fabrication).
    expect(result.display.riskTier).toBe("dusuk");
    expect(requests).toHaveLength(1); // no repair round was needed
  });
});
