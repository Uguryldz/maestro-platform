import {
  analysisSchemaName,
  DEFAULT_ANALYSIS_TEMPLATE,
  RoleOutputError,
} from "@maestro/agent-roles";
import type { GenerateObjectRequest, LlmCallLog, TicketSnapshot } from "@maestro/contracts";
import type { AgentSessionResult, LlmOutcome, LlmPort } from "@maestro/ports";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  AnalysisHaltedError,
  applyTemplateOverlay,
  buildAnalysisContext,
  produceAnalysis,
  requestIntake,
} from "../src/analysis.js";

/**
 * The pilot's analysis step now runs the REAL agent-roles analyst against the
 * REAL corporate template (M108/M109). These offline tests use a mock LlmPort
 * (no network): they prove the analyst is driven by the template/variant/data
 * class, that a template-valid output projects onto the frozen AnalysisDoc, that
 * masked values are re-inserted for the display copy, and that a template
 * violation fails CLOSED — an analysis missing a section never reaches a gate.
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

/** Section-keyed analyst output valid against the corporate template. */
function validOutput(purpose = defaultPurpose()): Record<string, unknown> {
  return {
    riskTier: "dusuk",
    riskReason: "Yüzey sınırlı olduğundan risk düşük değerlendirildi.",
    clarificationsUsed: [],
    sections: {
      purpose,
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
        { section: "purpose", claim: "makbuz gönderimi", kind: "ticket", ref: "OPS-6" },
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

function defaultPurpose(): string {
  return "İşlem onayında müşteriye makbuz e-postası gönderilecek. Böylece manuel talepler azalacak.";
}

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

interface MockOptions {
  /** Value(s) the mock returns per call; the last is reused when exhausted. */
  values: Array<Record<string, unknown>>;
  unmask?: <R>(value: R) => R;
}

/** Records the requests so the test can assert what the analyst was driven with. */
function mockLlm(opts: MockOptions): { llm: LlmPort; requests: GenerateObjectRequest[] } {
  const requests: GenerateObjectRequest[] = [];
  let call = 0;
  const llm: LlmPort = {
    generateObject<T>(req: GenerateObjectRequest, _schema: z.ZodType<T>): Promise<LlmOutcome<T>> {
      requests.push(req);
      const value = opts.values[Math.min(call, opts.values.length - 1)];
      call += 1;
      const ok = {
        status: "ok" as const,
        value: value as unknown as T,
        log: LOG,
        ...(opts.unmask ? { unmask: opts.unmask } : {}),
      };
      return Promise.resolve(ok);
    },
    agentSession(): Promise<LlmOutcome<AgentSessionResult>> {
      throw new Error("agentSession not used");
    },
  };
  return { llm, requests };
}

describe("pilot analizi — gerçek agent-roles analyst (offline)", () => {
  it("bağlamı canlı ticket'tan kurar; bilgi/repo-kartı henüz boş (TODO)", () => {
    const context = buildAnalysisContext(TICKET);
    expect(context.ticket).toBe(TICKET);
    expect(context.knowledge.repoCards).toEqual([]);
    expect(context.knowledge.knowledgeDocs).toEqual([]);
    expect(context.discovery.files).toEqual([]);
    expect(context.clarifications).toEqual([]);
  });

  it("runAnalyst'i gerçek şablon/varyant/veri sınıfı ile çağırır", async () => {
    const { llm, requests } = mockLlm({ values: [validOutput()] });
    await produceAnalysis({ llm, ticket: TICKET, variantId: "pilot-v1", dataClass: "gizli" });

    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.role).toBe("analyst");
    expect(req.variantId).toBe("pilot-v1");
    expect(req.dataClass).toBe("gizli");
    // The schema name carries the pinned template id + version (M83).
    expect(req.schemaName).toBe(analysisSchemaName(DEFAULT_ANALYSIS_TEMPLATE));
    // The prompt is the real templated prompt — the ticket description travels in it.
    expect(req.input).toContain(TICKET.description);
  });

  it("şablon-geçerli çıktı, aşağıya akan AnalysisDoc'a eşlenir", async () => {
    const { llm } = mockLlm({ values: [validOutput()] });
    const result = await produceAnalysis({
      llm,
      ticket: TICKET,
      variantId: "pilot-v1",
      dataClass: "gizli",
    });

    // A valid, frozen AnalysisDoc — exactly what the Jira comment and docs read.
    expect(result.display.templateVersion).toBe(DEFAULT_ANALYSIS_TEMPLATE.version);
    expect(result.display.language).toBe("tr");
    expect(result.display.riskTier).toBe("dusuk");
    expect(result.display.impactMatrix.length).toBeGreaterThan(0);
    expect(result.display.acceptanceCriteria.length).toBeGreaterThanOrEqual(3);
    expect(result.display.scope.included).toContain("Makbuz üretimi");
    expect(result.display.riskAndRollback.rollback).toContain("bayrağı");
    expect(result.attempts).toBe(1);
  });

  it("maskeli çıktının gerçek değerleri display kopyasında geri konur (M20/M82)", async () => {
    // Simulate a masked route: the model output carries a mask token, and the
    // gateway's unmask reverses it. The display copy must show the real value;
    // the masked copy keeps the token (the copy a journal may retain).
    const TOKEN = "[EMAIL_1.ab12]";
    const REAL = "musteri@bank.example";
    const masked = validOutput(
      `İşlem onayında müşteriye ${TOKEN} adresine makbuz e-postası gönderilecek. Böylece şubeye gelen manuel makbuz talepleri belirgin şekilde azalacak.`,
    );
    const unmask = <R>(value: R): R =>
      JSON.parse(JSON.stringify(value).split(TOKEN).join(REAL)) as R;

    const { llm } = mockLlm({ values: [masked], unmask });
    const result = await produceAnalysis({
      llm,
      ticket: TICKET,
      variantId: "pilot-v1",
      dataClass: "gizli",
    });

    expect(result.display.purpose).toContain(REAL);
    expect(result.display.purpose).not.toContain(TOKEN);
    expect(result.masked.purpose).toContain(TOKEN);
    expect(result.masked.purpose).not.toContain(REAL);
  });

  it("şablonu ihlal eden çıktı (eksik bölüm) fail-closed reddedilir", async () => {
    // A section removed — the generated schema refuses it, the single repair
    // round returns the same deficient doc, and runAnalyst throws. The analysis
    // never reaches the gate.
    const broken = validOutput();
    delete (broken["sections"] as Record<string, unknown>)["acceptanceCriteria"];

    const { llm, requests } = mockLlm({ values: [broken] });
    await expect(
      produceAnalysis({ llm, ticket: TICKET, variantId: "pilot-v1", dataClass: "gizli" }),
    ).rejects.toBeInstanceOf(RoleOutputError);
    // One call + repair rounds up to the role budget (MAX_ROLE_ATTEMPTS=3,
    // BULGU-1 sonrası 2→3), then a hard failure — fail-closed korunur.
    expect(requests).toHaveLength(3);
  });

  it("uydurma kaynak (bağlamda olmayan referans) fail-closed reddedilir", async () => {
    // Every source row points at a repo_file the analyst was never shown — an
    // empty knowledge pack makes this a fabrication (M98/M109), refused.
    const fabricated = validOutput();
    (fabricated["sections"] as Record<string, unknown>)["sources"] = [
      { section: "purpose", claim: "x", kind: "repo_file", ref: "src/does/not/exist.ts" },
    ];
    const { llm } = mockLlm({ values: [fabricated] });
    await expect(
      produceAnalysis({ llm, ticket: TICKET, variantId: "pilot-v1", dataClass: "gizli" }),
    ).rejects.toBeInstanceOf(RoleOutputError);
  });

  it("ok-olmayan model durumu (blocked) AnalysisHaltedError'a çevrilir", async () => {
    const llm: LlmPort = {
      generateObject<T>(): Promise<LlmOutcome<T>> {
        return Promise.resolve({ status: "blocked", messageKey: "policy.block", dataClass: "gizli" });
      },
      agentSession(): Promise<LlmOutcome<AgentSessionResult>> {
        throw new Error("unused");
      },
    };
    await expect(
      produceAnalysis({ llm, ticket: TICKET, variantId: "pilot-v1", dataClass: "gizli" }),
    ).rejects.toBeInstanceOf(AnalysisHaltedError);
  });
});

describe("applyTemplateOverlay — Studio şablonunun güvenli overlay'i (M108)", () => {
  it("eşleşen key'in yalnız title + aiInstruction'ı DB değeriyle değişir; bindings aynen kalır", () => {
    const { template, unmatched } = applyTemplateOverlay({
      sections: [
        { key: "purpose", title: "İş Değeri (Studio)", aiInstruction: "Amacı iki cümlede yaz." },
        { key: "uiApiChanges", aiInstruction: "Her uç noktayı tabloya yaz." },
      ],
    });

    expect(unmatched).toEqual([]);
    const purpose = template.sections.find((s) => s.key === "purpose")!;
    const basePurpose = DEFAULT_ANALYSIS_TEMPLATE.sections.find((s) => s.key === "purpose")!;
    expect(purpose.title).toBe("İş Değeri (Studio)");
    expect(purpose.aiInstruction).toBe("Amacı iki cümlede yaz.");
    // The structural/binding fields are the engine's, untouched.
    expect(purpose.contractField).toBe(basePurpose.contractField);
    expect(purpose.format).toBe(basePurpose.format);
    expect(purpose.required).toBe(basePurpose.required);
    expect(purpose.example).toBe(basePurpose.example);

    // A partial overlay (only aiInstruction) keeps the engine title, and the
    // table section's columns binding survives verbatim.
    const uiApi = template.sections.find((s) => s.key === "uiApiChanges")!;
    const baseUiApi = DEFAULT_ANALYSIS_TEMPLATE.sections.find((s) => s.key === "uiApiChanges")!;
    expect(uiApi.title).toBe(baseUiApi.title);
    expect(uiApi.aiInstruction).toBe("Her uç noktayı tabloya yaz.");
    expect(uiApi.columns).toEqual(baseUiApi.columns);

    // Sections the overlay does not name are the SAME objects (no rebuild).
    const risk = template.sections.find((s) => s.key === "riskAndRollback")!;
    const baseRisk = DEFAULT_ANALYSIS_TEMPLATE.sections.find((s) => s.key === "riskAndRollback")!;
    expect(risk).toBe(baseRisk);
    // The engine's identity fields never change (pinning/schema name intact).
    expect(template.templateId).toBe(DEFAULT_ANALYSIS_TEMPLATE.templateId);
    expect(template.version).toBe(DEFAULT_ANALYSIS_TEMPLATE.version);
  });

  it("DEFAULT'ta olmayan key sessizce atlanmaz — unmatched listesine düşer, bölüm EKLENMEZ", () => {
    const { template, unmatched } = applyTemplateOverlay({
      sections: [
        { key: "guvenlikAnalizi", title: "Güvenlik Analizi", aiInstruction: "Tehdit modelini yaz." },
        { key: "purpose", aiInstruction: "Amacı yaz." },
      ],
    });

    expect(unmatched).toEqual(["guvenlikAnalizi"]);
    // The engine's structure is fixed: no section was added or removed.
    expect(template.sections.map((s) => s.key)).toEqual(
      DEFAULT_ANALYSIS_TEMPLATE.sections.map((s) => s.key),
    );
  });

  it("null overlay → DEFAULT şablon birebir (aynı referans)", () => {
    const { template, unmatched } = applyTemplateOverlay(null);
    expect(template).toBe(DEFAULT_ANALYSIS_TEMPLATE);
    expect(unmatched).toEqual([]);
  });

  it("boş/whitespace DB değeri bir prompt'u asla silemez — alan uygulanmaz", () => {
    const { template } = applyTemplateOverlay({
      sections: [{ key: "purpose", title: "   ", aiInstruction: "" }],
    });
    const purpose = template.sections.find((s) => s.key === "purpose")!;
    const basePurpose = DEFAULT_ANALYSIS_TEMPLATE.sections.find((s) => s.key === "purpose")!;
    expect(purpose.title).toBe(basePurpose.title);
    expect(purpose.aiInstruction).toBe(basePurpose.aiInstruction);
  });

  it("DEFAULT şablonun kendisi asla mutate edilmez (kopya üzerinde çalışır)", () => {
    const before = JSON.stringify(DEFAULT_ANALYSIS_TEMPLATE);
    applyTemplateOverlay({
      sections: [{ key: "purpose", title: "Değişti", aiInstruction: "Değişti." }],
    });
    expect(JSON.stringify(DEFAULT_ANALYSIS_TEMPLATE)).toBe(before);
  });

  it("overlay'li şablonla üretim: analyst şablon-geçerli çıktıyla yine AnalysisDoc'a düşer", async () => {
    const { llm, requests } = mockLlm({ values: [validOutput()] });
    const { template } = applyTemplateOverlay({
      sections: [{ key: "purpose", title: "İş Değeri", aiInstruction: "Amacı net yaz." }],
    });
    const result = await produceAnalysis({
      llm,
      ticket: TICKET,
      variantId: "pilot-v1",
      dataClass: "gizli",
      template,
    });

    // The pinning identity is unchanged (same templateId@version)…
    expect(requests[0]!.schemaName).toBe(analysisSchemaName(DEFAULT_ANALYSIS_TEMPLATE));
    // …the Studio instruction reached the prompt…
    expect(requests[0]!.input).toContain("Amacı net yaz.");
    // …and the projection onto the frozen AnalysisDoc still holds (bindings intact).
    expect(result.display.templateVersion).toBe(DEFAULT_ANALYSIS_TEMPLATE.version);
    expect(result.display.impactMatrix.length).toBeGreaterThan(0);
  });
});

describe("pilot intake/clarify geçidi — gerçek agent-roles intake (offline)", () => {
  it("dolu ticket → complete:true; analiz üretilebilir", async () => {
    const { llm, requests } = mockLlm({ values: [{ complete: true, missing: [] }] });
    const intake = await requestIntake({
      llm,
      ticket: TICKET,
      variantId: "pilot-v1",
      dataClass: "gizli",
    });

    expect(intake.complete).toBe(true);
    expect(intake.display.missing).toEqual([]);
    // Same LLM/variant/data-class inputs the analyst uses (the intake role, though).
    const req = requests[0]!;
    expect(req.role).toBe("intake");
    expect(req.variantId).toBe("pilot-v1");
    expect(req.dataClass).toBe("gizli");
    // The ticket title + description travel in the real intake prompt.
    expect(req.input).toContain(TICKET.summary);
    expect(req.input).toContain(TICKET.description);
  });

  it("belirsiz ticket → complete:false ve açık sorular taşınır (missing)", async () => {
    // The real intake output for a too-thin ticket: it names what is missing and
    // asks about it. Its shape gives it nowhere to invent a value.
    const incomplete = {
      complete: false,
      missing: [
        {
          field: "kabul kriterleri",
          why: "Ticket'ta ölçülebilir kabul kriteri yok.",
          question: "Bu işin başarı ölçütleri neler? Kabul kriterlerini yazar mısınız?",
        },
        {
          field: "kapsam",
          why: "Hangi ekranların/servislerin etkileneceği belirtilmemiş.",
          question: "Değişiklik hangi ekran veya servisleri kapsıyor?",
        },
      ],
    };
    const { llm } = mockLlm({ values: [incomplete] });
    const intake = await requestIntake({
      llm,
      ticket: TICKET,
      variantId: "pilot-v1",
      dataClass: "gizli",
    });

    expect(intake.complete).toBe(false);
    expect(intake.display.missing).toHaveLength(2);
    expect(intake.display.missing.map((m) => m.question)).toEqual([
      incomplete.missing[0]!.question,
      incomplete.missing[1]!.question,
    ]);
  });

  it("çelişkili çıktı (incomplete ama soru yok) fail-closed reddedilir", async () => {
    // validateIntake refuses "incomplete but asks nothing"; the single repair
    // round returns the same contradiction, and runIntake throws.
    const { llm } = mockLlm({ values: [{ complete: false, missing: [] }] });
    await expect(
      requestIntake({ llm, ticket: TICKET, variantId: "pilot-v1", dataClass: "gizli" }),
    ).rejects.toBeInstanceOf(RoleOutputError);
  });

  it("ok-olmayan model durumu (queued) AnalysisHaltedError'a çevrilir", async () => {
    const llm: LlmPort = {
      generateObject<T>(): Promise<LlmOutcome<T>> {
        return Promise.resolve({
          status: "queued",
          resumeAt: "2026-08-11T00:00:00.000Z",
          reason: "subscription_quota",
        });
      },
      agentSession(): Promise<LlmOutcome<AgentSessionResult>> {
        throw new Error("unused");
      },
    };
    await expect(
      requestIntake({ llm, ticket: TICKET, variantId: "pilot-v1", dataClass: "gizli" }),
    ).rejects.toBeInstanceOf(AnalysisHaltedError);
  });
});
