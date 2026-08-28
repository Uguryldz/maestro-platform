import { describe, expect, it } from "vitest";
import {
  AnalysisDoc,
  APPROVAL_GATE_STEPS,
  GateDecision,
  GATES_BY_RISK,
  isScanBlocking,
  isSubscriptionDriver,
  MatchResult,
  STEP_IDS,
  STEP_META,
  TicketKey,
  TicketSnapshot,
} from "../src/index.js";

const validAnalysis = {
  templateVersion: "v3",
  language: "tr",
  purpose: "Customers raise credit limits without branch approval.",
  scope: { included: ["POST /api/credit/limit"], excluded: ["mobile screens"] },
  impactMatrix: [
    { appId: "ugurpay", impacted: true, summary: "new endpoint + form", source: "primary_repo_discovery" },
    { appId: "desktop", impacted: false, summary: "no change", source: "repo_card" },
  ],
  acceptanceCriteria: ["limit ceiling read from config"],
  uiApiChanges: "POST /api/credit/limit (new)",
  testApproach: "unit ~20, integration ~6, e2e 2",
  riskAndRollback: { risk: "misconfigured ceiling", mitigation: "validate at boot", rollback: "feature flag off" },
  riskTier: "orta",
  riskReason: "touches limits",
};

describe("AnalysisDoc (M43, fail-closed)", () => {
  it("accepts a complete document", () => {
    expect(AnalysisDoc.safeParse(validAnalysis).success).toBe(true);
  });
  it("rejects a missing section", () => {
    const { acceptanceCriteria: _drop, ...rest } = validAnalysis;
    expect(AnalysisDoc.safeParse(rest).success).toBe(false);
  });
  it("rejects unknown extra fields (strict)", () => {
    expect(AnalysisDoc.safeParse({ ...validAnalysis, extra: "x" }).success).toBe(false);
  });
});

describe("gates (M51)", () => {
  it("risk tiers map to 2/4/5 approval gates", () => {
    expect(GATES_BY_RISK.dusuk).toHaveLength(2);
    expect(GATES_BY_RISK.orta).toHaveLength(4);
    expect(GATES_BY_RISK.kritik).toHaveLength(5); // + 2b clarification wait = "6 gates"
  });
  it("every tier is a subset of the approval gate set, in flow order", () => {
    for (const steps of Object.values(GATES_BY_RISK)) {
      const idx = steps.map((s) => STEP_IDS.indexOf(s));
      expect(idx.every((i, n) => n === 0 || i > (idx[n - 1] ?? -1))).toBe(true);
      for (const s of steps) expect(APPROVAL_GATE_STEPS).toContain(s);
    }
  });
  it("approval gates are marked human_gate in step metadata", () => {
    for (const s of APPROVAL_GATE_STEPS) expect(STEP_META[s].kind).toBe("human_gate");
  });
  it("reject requires a reason", () => {
    const base = {
      step: "5",
      actorUserId: "ayse.kaya@corp",
      actorGroup: "tech-leads",
      sodVerified: true,
      signatureSeq: 1,
      source: "jira",
      at: "2026-08-08T10:00:00+03:00",
    };
    expect(GateDecision.safeParse({ ...base, decision: "approve" }).success).toBe(true);
    expect(GateDecision.safeParse({ ...base, decision: "reject" }).success).toBe(false);
    expect(GateDecision.safeParse({ ...base, decision: "reject", reason: "scope wrong" }).success).toBe(true);
  });
});

describe("ticket matching (M99)", () => {
  it("ai suggestion needs a confidence in [0,1]", () => {
    const ok = MatchResult.safeParse({ via: "ai_suggestion", appId: "ugurweb", confidence: 0.94, validatedAtGate: false });
    const bad = MatchResult.safeParse({ via: "ai_suggestion", appId: "ugurweb", confidence: 1.4, validatedAtGate: false });
    expect(ok.success).toBe(true);
    expect(bad.success).toBe(false);
  });
  it("fan-out children carry their parent", () => {
    expect(
      MatchResult.safeParse({ via: "analysis_fanout", parentTicketKey: "UGURPAY-500", appId: "ios" }).success,
    ).toBe(true);
  });
});

describe("jira shapes", () => {
  it("ticket keys follow Jira format", () => {
    expect(TicketKey.safeParse("UGURPAY-123").success).toBe(true);
    expect(TicketKey.safeParse("ugurpay-123").success).toBe(false);
    expect(TicketKey.safeParse("UGURPAY123").success).toBe(false);
  });
  it("snapshot defaults are Jira-friendly", () => {
    const t = TicketSnapshot.parse({
      key: "UGURWEB-104",
      projectKey: "UGURWEB",
      issueType: "Story",
      summary: "Password reset email verification",
      reporter: "can.ozkan@corp",
      createdAt: "2026-08-08T09:00:00+03:00",
      updatedAt: "2026-08-08T09:00:00+03:00",
    });
    expect(t.components).toEqual([]);
    expect(t.labels).toEqual([]);
    expect(t.assignee).toBeNull();
  });
});

describe("helpers", () => {
  it("scan fail-closed (M27): only pass unblocks", () => {
    expect(isScanBlocking("pass")).toBe(false);
    expect(isScanBlocking("fail")).toBe(true);
    expect(isScanBlocking("error")).toBe(true);
  });
  it("subscription drivers are recognized (M55)", () => {
    expect(isSubscriptionDriver("claude-sub")).toBe(true);
    expect(isSubscriptionDriver("anthropic-direct")).toBe(false);
  });
});
