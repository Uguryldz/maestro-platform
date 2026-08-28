import { describe, expect, it } from "vitest";
import { AnalysisDoc } from "@maestro/contracts";
import { TemplateError } from "../src/errors.js";
import { AnalysisTemplate, DEFAULT_ANALYSIS_TEMPLATE } from "../src/template.js";
import { toAnalysisDoc, toTemplatedAnalysis } from "../src/to-contract.js";
import { validAnalysis } from "./fixtures.js";

const template = DEFAULT_ANALYSIS_TEMPLATE;

describe("toAnalysisDoc", () => {
  it("produces a contract-valid AnalysisDoc from the templated output", () => {
    const doc = toAnalysisDoc(template, validAnalysis());
    expect(AnalysisDoc.safeParse(doc).success).toBe(true);
    expect(doc.templateVersion).toBe("v3");
    expect(doc.language).toBe("tr");
    expect(doc.scope.included).toContain("/api/credit/limit ucu");
    expect(doc.scope.excluded).toContain("risk skorlama motoru");
    expect(doc.impactMatrix).toHaveLength(2);
    expect(doc.riskAndRollback.rollback).toBe("Özellik bayrağı kapatılır.");
    expect(doc.clarificationsUsed).toEqual(["C1"]);
  });

  it("renders a table-shaped section into the contract's text field", () => {
    const doc = toAnalysisDoc(template, validAnalysis());
    expect(doc.uiApiChanges).toContain("| Yüzey | Durum | Geriye uyum |");
    expect(doc.uiApiChanges).toContain("POST /api/credit/limit");
  });

  it("falls back to the template's 'no change' wording for a skipped optional section", () => {
    const output = validAnalysis();
    delete output.sections["uiApiChanges"];
    expect(toAnalysisDoc(template, output).uiApiChanges).toBe("Değişiklik yok.");
  });

  it("fails loudly when the template drops a contract binding", () => {
    const drifted = AnalysisTemplate.parse({
      ...template,
      sections: template.sections.filter((s) => s.contractField !== "purpose"),
    });
    expect(() => toAnalysisDoc(drifted, validAnalysis())).toThrow(TemplateError);
  });

  it("fails when a bound composite section lacks the contract sub-keys", () => {
    const drifted = AnalysisTemplate.parse({
      ...template,
      sections: template.sections.map((s) =>
        s.key === "scope"
          ? { ...s, subLists: [{ key: "dahil", label: "Dahil", minItems: 1 }] }
          : s,
      ),
    });
    expect(() => toAnalysisDoc(drifted, validAnalysis())).toThrow(/included/);
  });
});

describe("toTemplatedAnalysis", () => {
  it("keeps the extra sections the contract has no room for", () => {
    const templated = toTemplatedAnalysis(template, validAnalysis());
    expect(Object.keys(templated.sections)).toContain("sources");
    expect(Object.keys(templated.sections)).toContain("openItems");
    expect(templated.templateVersion).toBe("v3");
    expect(templated.markdown).toContain("## 8. Kaynaklar");
  });

  it("carries a Studio-added section through untouched (M108)", () => {
    const extended = AnalysisTemplate.parse({
      ...template,
      version: "v4",
      sections: [
        ...template.sections,
        {
          key: "compliance",
          title: "Mevzuat etkisi",
          aiInstruction: "Mevzuat etkisini yaz.",
          required: true,
          format: "free_text",
        },
      ],
    });
    const output = validAnalysis();
    output.sections["compliance"] = "KVKK açısından yeni kişisel veri işlenmiyor.";

    const templated = toTemplatedAnalysis(extended, output);
    expect(templated.markdown).toContain("## 10. Mevzuat etkisi");
    // The frozen contract is unaffected by the new section.
    expect(AnalysisDoc.safeParse(toAnalysisDoc(extended, output)).success).toBe(true);
  });
});
