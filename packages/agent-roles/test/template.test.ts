import { describe, expect, it } from "vitest";
import {
  AnalysisTemplate,
  DEFAULT_ANALYSIS_TEMPLATE,
  claimSections,
  openItemsSection,
  sourceSection,
} from "../src/template.js";

describe("default analysis template", () => {
  it("carries the seven corporate sections plus the two M109 sections", () => {
    const keys = DEFAULT_ANALYSIS_TEMPLATE.sections.map((s) => s.key);
    expect(keys).toEqual([
      "purpose",
      "scope",
      "impactMatrix",
      "acceptanceCriteria",
      "uiApiChanges",
      "testApproach",
      "riskAndRollback",
      "sources",
      "openItems",
    ]);
  });

  it("marks Kaynaklar and Netleştirilecek açık maddeler mandatory", () => {
    expect(sourceSection(DEFAULT_ANALYSIS_TEMPLATE)?.required).toBe(true);
    expect(openItemsSection(DEFAULT_ANALYSIS_TEMPLATE)?.required).toBe(true);
  });

  it("treats every section but the two M109 ones as claim-bearing", () => {
    expect(claimSections(DEFAULT_ANALYSIS_TEMPLATE).map((s) => s.key)).not.toContain("sources");
    expect(claimSections(DEFAULT_ANALYSIS_TEMPLATE)).toHaveLength(7);
  });

  it("gives every section a Turkish AI instruction (M59)", () => {
    for (const section of DEFAULT_ANALYSIS_TEMPLATE.sections) {
      expect(section.aiInstruction.length).toBeGreaterThan(20);
    }
  });
});

describe("template validation", () => {
  const base = {
    templateId: "t",
    version: "v1",
    name: "T",
    locale: "tr" as const,
  };
  const freeText = {
    key: "a",
    title: "A",
    aiInstruction: "Doldur.",
    required: true,
    format: "free_text" as const,
  };

  it("rejects duplicate section keys", () => {
    const result = AnalysisTemplate.safeParse({ ...base, sections: [freeText, freeText] });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate contract bindings", () => {
    const result = AnalysisTemplate.safeParse({
      ...base,
      sections: [
        { ...freeText, contractField: "purpose" },
        { ...freeText, key: "b", contractField: "purpose" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects more than one Kaynaklar section", () => {
    const sources = { ...freeText, format: "source_list" as const };
    const result = AnalysisTemplate.safeParse({
      ...base,
      sections: [sources, { ...sources, key: "b" }],
    });
    expect(result.success).toBe(false);
  });

  it("requires columns for a table section and forbids them elsewhere", () => {
    expect(
      AnalysisTemplate.safeParse({
        ...base,
        sections: [{ ...freeText, format: "table" }],
      }).success,
    ).toBe(false);
    expect(
      AnalysisTemplate.safeParse({
        ...base,
        sections: [{ ...freeText, columns: ["x"] }],
      }).success,
    ).toBe(false);
    expect(
      AnalysisTemplate.safeParse({
        ...base,
        sections: [{ ...freeText, format: "table", columns: ["x"] }],
      }).success,
    ).toBe(true);
  });
});
