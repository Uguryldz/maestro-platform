import { describe, expect, it } from "vitest";
import {
  AppId,
  ApplicationRecord,
  DataClass,
  JiraProjectBinding,
  JournalEntry,
  LlmCallLog,
  LlmDriverId,
  MatchResult,
  RepoCard,
  RiskTier,
  RoutingRule,
  STEP_IDS,
  STEP_META,
  TicketKey,
  WorkflowRunStatus,
  WorkMode,
} from "@maestro/contracts";
import {
  buildDemoDataset,
  DEMO_TICKETS,
  demoRunId,
  NO_PASSWORD_SET,
  toJiraProjectBinding,
  toRoutingRule,
} from "../src/index.js";

const data = buildDemoDataset();

describe("demo dataset shape (insa-plani: seed = the mock dataset)", () => {
  it("carries the headline counts", () => {
    expect(data.applications.length).toBe(5);
    expect(data.repoCards.length).toBe(5);
    expect(data.bindings.filter((b) => b.state === "active").length).toBe(4);
    expect(data.runs.length).toBe(22);
    expect(data.routingRules.length).toBeGreaterThanOrEqual(5);
    expect(data.users.length).toBe(7);
  });

  it("spreads the 22 runs over every interesting status", () => {
    const byStatus = new Map<string, number>();
    for (const run of data.runs) {
      byStatus.set(String(run.status), (byStatus.get(String(run.status)) ?? 0) + 1);
    }
    expect(byStatus.get("gate")).toBe(7);
    expect(byStatus.get("running")).toBe(8);
    expect(byStatus.get("queued")).toBe(1);
    expect(byStatus.get("fail")).toBe(1);
    expect(byStatus.get("done")).toBe(5);
    expect([...byStatus.values()].reduce((a, b) => a + b, 0)).toBe(22);
  });

  it("represents all three data classes (M18 routing has to be visible)", () => {
    const classes = new Set(data.runs.map((run) => String(run.dataClass)));
    expect([...classes].sort()).toEqual([...DataClass.options].sort());
  });

  it("is deterministic — two builds are identical", () => {
    expect(JSON.stringify(buildDemoDataset(), replacer)).toBe(JSON.stringify(data, replacer));
  });
});

/** BigInt is not JSON-serializable; only used by the determinism check. */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

describe("demo rows honour the contracts", () => {
  it("uses well-formed ticket keys, app ids and step ids", () => {
    for (const ticket of DEMO_TICKETS) {
      expect(TicketKey.safeParse(ticket.key).success, ticket.key).toBe(true);
      if (ticket.appId !== null) {
        expect(AppId.safeParse(ticket.appId).success, ticket.appId).toBe(true);
      }
      expect(STEP_IDS, ticket.key).toContain(ticket.step);
      expect(WorkflowRunStatus.options).toContain(ticket.status);
      expect(WorkMode.options).toContain(ticket.mode);
      expect(DataClass.options).toContain(ticket.dataClass);
      if (ticket.risk !== null) expect(RiskTier.options).toContain(ticket.risk);
    }
  });

  it("stores a valid MatchResult on every run (M99: no silent default)", () => {
    for (const ticket of DEMO_TICKETS) {
      const parsed = MatchResult.safeParse(ticket.match);
      expect(parsed.success, `${ticket.key}: ${parsed.error?.message ?? ""}`).toBe(true);
    }
  });

  it("keeps a rule-matched run's appId and its MatchResult in agreement", () => {
    for (const ticket of DEMO_TICKETS) {
      const match = MatchResult.parse(ticket.match);
      if (match.via === "onboarding") continue;
      expect(match.appId, ticket.key).toBe(ticket.appId);
    }
  });

  it("validates every application against ApplicationRecord", () => {
    for (const app of data.applications) {
      const parsed = ApplicationRecord.safeParse({
        appId: app.appId,
        displayName: app.displayName,
        adoProject: app.adoProject,
        adoRepo: app.adoRepo,
        platform: app.platform,
        jiraComponent: app.jiraComponent ?? null,
        maestroYamlPresent: app.maestroYamlPresent,
        createdVia: app.createdVia,
      });
      expect(parsed.success, `${app.appId}: ${parsed.error?.message ?? ""}`).toBe(true);
    }
  });

  it("validates every repo card against RepoCard", () => {
    for (const card of data.repoCards) {
      const parsed = RepoCard.safeParse({
        appId: card.appId,
        modules: card.modulesJson,
        generatedFromSha: card.generatedFromSha,
        version: card.version,
        updatedAt: (card.updatedAt as Date).toISOString(),
      });
      expect(parsed.success, `${card.appId}: ${parsed.error?.message ?? ""}`).toBe(true);
    }
  });

  it("validates every routing rule against the whole RoutingRule contract", () => {
    for (const row of data.routingRules) {
      const parsed = RoutingRule.safeParse(
        toRoutingRule({
          ruleId: row.ruleId,
          projectKey: (row.projectKey ?? null) as string | null,
          conditionJson: row.conditionJson,
          effectJson: row.effectJson,
          priority: row.priority,
        }),
      );
      expect(parsed.success, `${row.ruleId}: ${parsed.error?.message ?? ""}`).toBe(true);
    }
  });

  it("stores the org-wide guard rule (M99 tier 1) as NULL, read back as '*'", () => {
    const orgWide = data.routingRules.filter((rule) => rule.projectKey === null);
    expect(orgWide.length).toBe(1);
    const rule = toRoutingRule({
      ruleId: String(orgWide[0]?.ruleId),
      projectKey: null,
      conditionJson: orgWide[0]?.conditionJson,
      effectJson: orgWide[0]?.effectJson,
      priority: Number(orgWide[0]?.priority),
    });
    expect(rule.projectKey).toBe("*");
    expect(rule.effect).toEqual({ mode: "human_lead", dataClass: "gizli" });
  });

  it("folds org-wide rules into every binding, in priority order (M102 ruleIds)", () => {
    const rules = data.routingRules.map((rule) => ({
      ruleId: rule.ruleId,
      projectKey: (rule.projectKey ?? null) as string | null,
      conditionJson: rule.conditionJson,
      effectJson: rule.effectJson,
      priority: rule.priority,
    }));
    for (const row of data.bindings) {
      const binding = toJiraProjectBinding(
        {
          projectKey: row.projectKey,
          trigger: row.trigger,
          triggerLabel: String(row.triggerLabel),
          defaultsJson: row.defaultsJson,
          state: row.state,
          dryRunSampleSize: Number(row.dryRunSampleSize),
          lastDryRunAt: (row.lastDryRunAt as Date | null) ?? null,
          version: Number(row.version),
        },
        rules,
      );
      expect(JiraProjectBinding.safeParse(binding).success, row.projectKey).toBe(true);
      expect(binding.ruleIds, row.projectKey).toContain("rule-7");
      const priorities = binding.ruleIds.map((id) => rules.find((r) => r.ruleId === id)?.priority ?? -1);
      expect([...priorities].sort((a, b) => a - b), row.projectKey).toEqual(priorities);
    }
  });

  it("validates every journal entry against JournalEntry", () => {
    for (const entry of data.journal) {
      const parsed = JournalEntry.safeParse({
        runId: entry.runId,
        seq: entry.seq,
        at: (entry.at as Date).toISOString(),
        actor: entry.actor,
        kind: entry.kind,
        title: entry.title,
        detail: entry.detail,
        ...(entry.costJson === undefined ? {} : { cost: entry.costJson }),
      });
      expect(parsed.success, `${entry.runId}#${entry.seq}: ${parsed.error?.message ?? ""}`).toBe(
        true,
      );
    }
  });

  it("validates every llm call against LlmCallLog", () => {
    for (const call of data.llmCalls) {
      expect(LlmDriverId.options).toContain(call.driver);
      const parsed = LlmCallLog.safeParse({
        at: (call.at as Date).toISOString(),
        runId: call.runId ?? null,
        role: call.role,
        variantId: call.variantId,
        driver: call.driver,
        model: call.model,
        tokensIn: call.tokensIn,
        tokensOut: call.tokensOut,
        cachePct: call.cachePct ?? null,
        usd: call.usd === null || call.usd === undefined ? null : Number(call.usd),
        dataClass: call.dataClass,
      });
      expect(parsed.success, `${call.variantId}: ${parsed.error?.message ?? ""}`).toBe(true);
    }
  });

  it("charges subscription drivers in quota, not dollars (M55)", () => {
    for (const call of data.llmCalls) {
      if (String(call.driver).endsWith("-sub")) expect(call.usd ?? null).toBeNull();
    }
  });
});

describe("step events carry the contract's own step kind (STEP_META)", () => {
  it("never derives the kind from the run status", () => {
    expect(data.stepEvents.length).toBeGreaterThan(0);
    for (const event of data.stepEvents) {
      const step = String(event.step) as keyof typeof STEP_META;
      expect(STEP_META[step], `unknown step ${String(event.step)}`).toBeDefined();
      expect(event.kind, `${event.runId} step ${step}`).toBe(STEP_META[step].kind);
    }
  });

  it("classifies the three steps the old status-based rule got wrong", () => {
    const kindOf = (runId: string, step: string): unknown =>
      data.stepEvents.find((e) => e.runId === runId && e.step === step)?.kind;
    expect(kindOf(demoRunId("UGURPAY-712"), "2b")).toBe("human_wait");
    expect(kindOf(demoRunId("UGURWEB-88"), "6b")).toBe("system");
    expect(kindOf(demoRunId("UGURDESK-45"), "10b")).toBe("auto_gate");
  });
});

describe("referential integrity (the seed must load in one pass)", () => {
  const appIds = new Set(data.applications.map((a) => a.appId));
  const runIds = new Set(data.runs.map((r) => r.id));
  const variantIds = new Set(data.variants.map((v) => v.id));

  it("points every run at a known application", () => {
    for (const run of data.runs) {
      if (run.appId !== null && run.appId !== undefined) expect(appIds).toContain(run.appId);
    }
  });

  it("points every child row at a parent that exists", () => {
    for (const card of data.repoCards) expect(appIds).toContain(card.appId);
    for (const event of data.stepEvents) expect(runIds).toContain(event.runId);
    for (const entry of data.journal) expect(runIds).toContain(entry.runId);
    for (const version of data.variantVersions) expect(variantIds).toContain(version.variantId);
    for (const evidence of data.evidencePackages) expect(runIds).toContain(evidence.runId);
    for (const call of data.llmCalls) expect(runIds).toContain(call.runId);
  });

  it("keeps knowledge docs unique per (id, version) — M83 pinning", () => {
    const keys = data.knowledgeDocs.map((doc) => `${doc.id}@${doc.version}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(data.knowledgeDocs.filter((doc) => doc.id === "analiz-sablonu").length).toBe(2);
  });

  it("derives run ids from ticket keys", () => {
    for (const run of data.runs) expect(run.id).toBe(demoRunId(String(run.ticketKey)));
  });
});

describe("users", () => {
  it("ships no usable credential", () => {
    for (const user of data.users) {
      expect(user.passwordHash).toBe(NO_PASSWORD_SET);
      expect(String(user.email)).toMatch(/@/);
    }
  });
});
