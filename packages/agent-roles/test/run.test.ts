import { describe, expect, it } from "vitest";
import { createMockLlm } from "@maestro/test-kit";
import { RoleOutputError } from "../src/errors.js";
import { MAX_ROLE_ATTEMPTS } from "../src/run.js";
import { runAnalyst } from "../src/role-analyst.js";
import type { SourceEntry } from "../src/schema-builder.js";
import { analysisSchemaName } from "../src/schema-builder.js";
import { DEFAULT_ANALYSIS_TEMPLATE } from "../src/template.js";
import {
  analysisContext,
  outcomeLlm,
  scriptedLlm,
  twoPhaseLlm,
  validAnalysis,
} from "./fixtures.js";

const template = DEFAULT_ANALYSIS_TEMPLATE;
const context = analysisContext();
const base = { template, context, variantId: "web", dataClass: "dahili" as const };

function withoutSection(key: string) {
  const doc = validAnalysis();
  delete doc.sections[key];
  doc.sections["sources"] = (doc.sections["sources"] as SourceEntry[]).filter(
    (s) => s.section !== key,
  );
  return doc;
}

describe("runAnalyst", () => {
  it("returns the analysis on a first-pass answer", async () => {
    const { llm } = scriptedLlm([validAnalysis()]);
    const result = await runAnalyst({ llm, ...base });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.attempts).toBe(1);
    expect(result.logs).toHaveLength(1);
    expect(result.value.riskTier).toBe("orta");
  });

  it("works against the shared mock LLM, which validates the generated schema", async () => {
    const llm = createMockLlm({
      responses: { [`analyst:${analysisSchemaName(template)}`]: validAnalysis() },
    });
    const result = await runAnalyst({ llm, ...base });
    expect(result.status).toBe("ok");
  });

  it("repairs once with the concrete deficiency list, then accepts (M43)", async () => {
    const first = withoutSection("testApproach");
    const { llm, prompts } = scriptedLlm([first, validAnalysis()]);
    const result = await runAnalyst({ llm, ...base });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.attempts).toBe(2);
    expect(result.logs).toHaveLength(2);

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("GİDERİLECEK EKSİKLER");
    expect(prompts[1]).toContain("Test yaklaşımı");
    expect(prompts[1]).toContain("ÖNCEKİ CEVABIN");
    // CANLI BULGU-1: the repair round must order "keep everything, only add".
    expect(prompts[1]).toContain("TAMAMINI koru");
    expect(prompts[1]).toContain("Kaynaklar bölümüne yeni satır EKLE");
  });

  it("recovers on the second repair round — the budget is three attempts", async () => {
    const bad = withoutSection("testApproach");
    const { llm, prompts } = scriptedLlm([bad, bad, validAnalysis()]);
    const result = await runAnalyst({ llm, ...base });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.attempts).toBe(3);
    expect(result.logs).toHaveLength(3);
    expect(prompts).toHaveLength(3);
    // Both repair prompts are built on the ORIGINAL prompt, not on each other.
    expect(prompts[2]).toContain("GİDERİLECEK EKSİKLER");
    expect((prompts[2] ?? "").match(/GİDERİLECEK EKSİKLER/g)).toHaveLength(1);
  });

  it("fails closed after MAX_ROLE_ATTEMPTS — no fourth attempt", async () => {
    expect(MAX_ROLE_ATTEMPTS).toBe(3);
    const bad = withoutSection("testApproach");
    const { llm, prompts } = scriptedLlm([bad, bad, bad, validAnalysis()]);
    await expect(runAnalyst({ llm, ...base })).rejects.toBeInstanceOf(RoleOutputError);
    expect(prompts).toHaveLength(MAX_ROLE_ATTEMPTS);
  });

  it("reports the deficiencies on the error it throws", async () => {
    const doc = validAnalysis();
    doc.sections["sources"] = [];
    const { llm } = scriptedLlm([doc, doc, doc]);
    await expect(runAnalyst({ llm, ...base })).rejects.toMatchObject({
      role: "analyst",
      attempts: MAX_ROLE_ATTEMPTS,
      deficiencies: [expect.stringContaining("Kaynaklar")],
    });
  });

  it("rejects an unsourced analysis even though its shape is perfect (M98/M109)", async () => {
    const doc = validAnalysis();
    doc.sections["sources"] = (doc.sections["sources"] as SourceEntry[]).map((s) => ({
      ...s,
      ref: "src/uydurma/dosya.ts",
      kind: "repo_file" as const,
    }));
    const { llm } = scriptedLlm([doc, doc, doc]);
    await expect(runAnalyst({ llm, ...base })).rejects.toBeInstanceOf(RoleOutputError);
  });

  it("passes a queued quota straight back to the workflow (M55)", async () => {
    const llm = outcomeLlm({
      status: "queued",
      resumeAt: "2026-01-01T01:00:00+00:00",
      reason: "subscription_quota",
    });
    const result = await runAnalyst({ llm, ...base });
    expect(result).toEqual({
      status: "queued",
      resumeAt: "2026-01-01T01:00:00+00:00",
      reason: "subscription_quota",
      logs: [],
    });
  });

  it("passes degraded and blocked back untouched (M18/M97)", async () => {
    const degraded = await runAnalyst({
      llm: outcomeLlm({ status: "degraded", messageKey: "llm.degraded", dataClass: "gizli" }),
      ...base,
    });
    expect(degraded.status).toBe("degraded");

    const blocked = await runAnalyst({
      llm: outcomeLlm({ status: "blocked", messageKey: "llm.blocked", dataClass: "gizli" }),
      ...base,
    });
    expect(blocked.status).toBe("blocked");
  });

  it("keeps the first call's log when the repair round is queued (M55)", async () => {
    // The first call BURNED quota. If the repair round hits a full pool, that
    // burn must still be accounted for — the window tracker and the evidence
    // pack cannot be one call short.
    const { llm } = twoPhaseLlm(withoutSection("testApproach"), {
      status: "queued",
      resumeAt: "2026-01-01T01:00:00+00:00",
      reason: "subscription_quota",
    });
    const result = await runAnalyst({ llm, ...base });
    expect(result.status).toBe("queued");
    if (result.status !== "queued") return;
    expect(result.resumeAt).toBe("2026-01-01T01:00:00+00:00");
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0]?.role).toBe("analyst");
  });

  it("keeps the first call's log when the repair round is degraded (M18)", async () => {
    const { llm } = twoPhaseLlm(withoutSection("testApproach"), {
      status: "degraded",
      messageKey: "llm.degraded",
      dataClass: "gizli",
    });
    const result = await runAnalyst({ llm, ...base });
    expect(result.status).toBe("degraded");
    if (result.status !== "degraded") return;
    expect(result.logs).toHaveLength(1);
  });

  it("keeps the first call's log when the repair round is blocked (M97)", async () => {
    const { llm } = twoPhaseLlm(withoutSection("testApproach"), {
      status: "blocked",
      messageKey: "llm.blocked",
      dataClass: "gizli",
    });
    const result = await runAnalyst({ llm, ...base });
    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") return;
    expect(result.logs).toHaveLength(1);
  });

  it("reports no logs when the very first call never reached a backend", async () => {
    const result = await runAnalyst({
      llm: outcomeLlm({
        status: "queued",
        resumeAt: "2026-01-01T01:00:00+00:00",
        reason: "subscription_quota",
      }),
      ...base,
    });
    expect(result.status).toBe("queued");
    if (result.status !== "queued") return;
    expect(result.logs).toEqual([]);
  });

  it("sends the pinned schema name and the caller's data class to the port", async () => {
    const { llm, requests } = scriptedLlm([validAnalysis()]);
    const result = await runAnalyst({ llm, ...base });
    expect(result.status).toBe("ok");
    expect(requests[0]?.schemaName).toBe("AnalysisDoc@kurumsal-analiz@v3");
    expect(requests[0]?.dataClass).toBe("dahili");
    expect(requests[0]?.role).toBe("analyst");
    expect(requests[0]?.variantId).toBe("web");
  });
});
