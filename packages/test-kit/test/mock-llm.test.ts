import { describe, expect, it } from "vitest";
import { AnalysisDoc } from "@maestro/contracts";
import { createMockLlm } from "../src/index.js";

const analysisFixture = {
  templateVersion: "v3",
  language: "tr",
  purpose: "test purpose",
  scope: { included: ["x"], excluded: [] },
  impactMatrix: [{ appId: "ugurweb", impacted: true, summary: "form", source: "primary_repo_discovery" }],
  acceptanceCriteria: ["a"],
  uiApiChanges: "none",
  testApproach: "unit",
  riskAndRollback: { risk: "r", mitigation: "m", rollback: "rb" },
  riskTier: "dusuk",
  riskReason: "small",
};

describe("mock-llm", () => {
  const llm = createMockLlm({
    responses: { "analyst:AnalysisDoc": analysisFixture },
    agentResults: { "implement password reset": "done: 4 files changed" },
  });

  it("returns schema-validated canned objects", async () => {
    const outcome = await llm.generateObject(
      { role: "analyst", variantId: "v1", dataClass: "dahili", schemaName: "AnalysisDoc", input: {} },
      AnalysisDoc,
    );
    if (outcome.status !== "ok") return expect.unreachable("expected an ok outcome");
    expect(outcome.value.riskTier).toBe("dusuk");
    expect(outcome.log.usd).toBeNull();
  });

  it("fails when the fixture drifts from the contract", async () => {
    const bad = createMockLlm({ responses: { "analyst:AnalysisDoc": { purpose: "only this" } } });
    await expect(
      bad.generateObject(
        { role: "analyst", variantId: "v1", dataClass: "dahili", schemaName: "AnalysisDoc", input: {} },
        AnalysisDoc,
      ),
    ).rejects.toThrow();
  });

  it("fails loudly on unknown keys", async () => {
    await expect(
      llm.generateObject(
        { role: "intake", variantId: "v1", dataClass: "dahili", schemaName: "Nope", input: {} },
        AnalysisDoc,
      ),
    ).rejects.toThrow(/no canned response/);
  });

  it("serves deterministic agent sessions carrying the caller's data class", async () => {
    const outcome = await llm.agentSession({
      workspacePath: "/tmp/ws",
      task: "implement password reset flow",
      mcpServers: ["workspace-mcp"],
      dataClass: "dahili",
      variantId: "backend",
    });
    if (outcome.status !== "ok") return expect.unreachable("expected an ok outcome");
    expect(outcome.value.finalText).toContain("4 files");
    expect(outcome.log).toMatchObject({ dataClass: "dahili", variantId: "backend" });
  });
});
