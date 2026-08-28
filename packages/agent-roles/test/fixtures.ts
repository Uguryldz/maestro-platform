import type { GenerateObjectRequest, LlmCallLog, TicketSnapshot } from "@maestro/contracts";
import type { AgentSessionOptions, AgentSessionResult, LlmOutcome, LlmPort } from "@maestro/ports";
import type { AnalysisContext } from "../src/context.js";
import type { AnalysisOutput } from "../src/schema-builder.js";

const AT = "2026-01-01T00:00:00+00:00";

export function ticket(overrides: Partial<TicketSnapshot> = {}): TicketSnapshot {
  return {
    key: "UGURPAY-501",
    projectKey: "UGURPAY",
    issueType: "Story",
    summary: "Kredi limiti self-servis artırma",
    description: "Müşteri şube onayı beklemeden limitini artırabilmeli.",
    reporter: "ayse.kaya",
    assignee: null,
    components: ["credit"],
    labels: ["maestro"],
    parentKey: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

export function analysisContext(overrides: Partial<AnalysisContext> = {}): AnalysisContext {
  return {
    ticket: ticket(),
    discovery: {
      appId: "ugurpay-api",
      files: ["src/credit/limit-policy.ts", "src/credit/limit-controller.ts"],
      modules: ["credit"],
    },
    knowledge: {
      repoCards: [
        {
          appId: "ugurmobil-ios",
          modules: [{ name: "Kredi", path: "Sources/Kredi", summary: "Limit ekranı" }],
          generatedFromSha: "abc1234",
          version: 1,
          updatedAt: AT,
        },
      ],
      knowledgeDocs: [{ name: "test-piramidi.md", text: "Birim > entegrasyon > uçtan uca." }],
      codingStandards: [{ name: "kodlama-standardi.md", text: "Konfig sabit kodlanmaz." }],
      exampleAnalyses: [{ name: "ornek-analiz.md", text: "Örnek bir analiz gövdesi." }],
    },
    clarifications: [{ id: "C1", question: "Üst sınır nedir?", answer: "Risk ekibi belirler." }],
    ...overrides,
  };
}

/** A complete, source-covered analysis for the default template. */
export function validAnalysis(): AnalysisOutput {
  return {
    riskTier: "orta",
    riskReason: "Limit üst sınırı yanlış konfigüre edilirse finansal etki doğar.",
    clarificationsUsed: ["C1"],
    sections: {
      purpose:
        "Müşteri şube onayı beklemeden limitini artırabilmeli. Şube taleplerinin yarısının self-servise kayması hedefleniyor.",
      scope: {
        included: ["/api/credit/limit ucu", "web limit artırma formu"],
        excluded: ["mobil ekranlar", "risk skorlama motoru"],
      },
      impactMatrix: [
        {
          appId: "ugurpay-api",
          impacted: true,
          summary: "Yeni uç ve doğrulama kuralı",
          source: "primary_repo_discovery",
        },
        {
          appId: "ugurmobil-ios",
          impacted: true,
          summary: "Limit ekranı alt ticket'a çıkar",
          source: "repo_card",
        },
      ],
      acceptanceCriteria: [
        "Limit üst sınırı konfigürasyondan okunur.",
        "Üst sınırı aşan talep 422 ile reddedilir.",
        "Başarılı artırım audit kaydına yazılır.",
      ],
      uiApiChanges: [
        { Yüzey: "POST /api/credit/limit", Durum: "yeni", "Geriye uyum": "-" },
      ],
      testApproach: "Birim 20, entegrasyon 6, uçtan uca 2. Kapsam eşiği %70.",
      riskAndRollback: {
        risk: "Yanlış konfig ile fazla limit verilebilir.",
        mitigation: "Konfig açılışta doğrulanır.",
        rollback: "Özellik bayrağı kapatılır.",
      },
      sources: [
        {
          section: "purpose",
          claim: "Self-servis limit artırma talebi",
          kind: "ticket",
          ref: "UGURPAY-501",
        },
        {
          section: "scope",
          claim: "Limit ucu bu repoda",
          kind: "repo_file",
          ref: "src/credit/limit-controller.ts",
        },
        {
          section: "impactMatrix",
          claim: "iOS Kredi modülü limit ekranını taşıyor",
          kind: "repo_card",
          ref: "ugurmobil-ios",
        },
        {
          section: "acceptanceCriteria",
          claim: "Üst sınır bugün sabit kodlu",
          kind: "repo_file",
          ref: "src/credit/limit-policy.ts",
        },
        {
          section: "uiApiChanges",
          claim: "Limit ucu controller'da tanımlı",
          kind: "repo_file",
          ref: "src/credit/limit-controller.ts",
        },
        {
          section: "testApproach",
          claim: "Test piramidi kurum standardı",
          kind: "knowledge_doc",
          ref: "test-piramidi.md",
        },
        {
          section: "riskAndRollback",
          claim: "Üst sınırı risk ekibi belirler",
          kind: "clarification",
          ref: "C1",
        },
      ],
      openItems: [],
    },
  };
}

function log(req: GenerateObjectRequest): LlmCallLog {
  return {
    at: AT,
    runId: null,
    role: req.role,
    variantId: req.variantId,
    driver: "openai-compat",
    model: "scripted",
    tokensIn: 0,
    tokensOut: 0,
    cachePct: null,
    usd: null,
    dataClass: req.dataClass,
  };
}

export interface ScriptedLlm {
  llm: LlmPort;
  prompts: string[];
  requests: GenerateObjectRequest[];
}

/**
 * A port that returns canned values WITHOUT validating them. Real gateways do
 * validate, but this package must not depend on that — the scripted port is
 * how the repair round and the fail-closed refusal are exercised.
 */
export function scriptedLlm(values: readonly unknown[]): ScriptedLlm {
  const prompts: string[] = [];
  const requests: GenerateObjectRequest[] = [];
  let index = 0;
  const llm: LlmPort = {
    async generateObject<T>(req: GenerateObjectRequest): Promise<LlmOutcome<T>> {
      prompts.push(String(req.input));
      requests.push(req);
      if (index >= values.length) throw new Error("scripted-llm: no response left");
      const value = values[index++] as T;
      return { status: "ok", value, log: log(req) };
    },
    async agentSession(_opts: AgentSessionOptions): Promise<LlmOutcome<AgentSessionResult>> {
      throw new Error("scripted-llm: agentSession not used by thinking roles");
    },
  };
  return { llm, prompts, requests };
}

/**
 * A port that answers the first call (burning quota) and then falls into a
 * non-ok outcome. This is the shape of the M55 accounting gap: the first call
 * happened and must stay on the books even though the run cannot continue.
 */
export function twoPhaseLlm(first: unknown, then: LlmOutcome<never>): ScriptedLlm {
  const prompts: string[] = [];
  const requests: GenerateObjectRequest[] = [];
  let calls = 0;
  const llm: LlmPort = {
    async generateObject<T>(req: GenerateObjectRequest): Promise<LlmOutcome<T>> {
      prompts.push(String(req.input));
      requests.push(req);
      calls += 1;
      if (calls === 1) return { status: "ok", value: first as T, log: log(req) };
      return then as LlmOutcome<T>;
    },
    async agentSession(): Promise<LlmOutcome<AgentSessionResult>> {
      throw new Error("two-phase-llm: agentSession not used");
    },
  };
  return { llm, prompts, requests };
}

/** A port stuck in one of the non-ok outcomes (M18/M55). */
export function outcomeLlm(outcome: LlmOutcome<never>): LlmPort {
  return {
    async generateObject<T>(): Promise<LlmOutcome<T>> {
      return outcome as LlmOutcome<T>;
    },
    async agentSession(): Promise<LlmOutcome<AgentSessionResult>> {
      throw new Error("outcome-llm: agentSession not used");
    },
  };
}
