import { describe, expect, it } from "vitest";
import { TemplateError } from "../src/errors.js";
import { analysisSchemaName, buildAnalysisSchema } from "../src/schema-builder.js";
import { AnalysisTemplate, DEFAULT_ANALYSIS_TEMPLATE } from "../src/template.js";
import { validAnalysis } from "./fixtures.js";

/** A template section added the way Studio would add one: as data. */
const COMPLIANCE_SECTION = {
  key: "compliance",
  title: "Mevzuat etkisi",
  description: "BDDK/KVKK etkisi",
  aiInstruction: "Mevzuat etkisini yaz; yoksa 'etki yok' de.",
  example: "KVKK açısından yeni kişisel veri işlenmiyor.",
  required: true,
  format: "free_text" as const,
};

function withCompliance(): AnalysisTemplate {
  return AnalysisTemplate.parse({
    ...DEFAULT_ANALYSIS_TEMPLATE,
    version: "v4",
    sections: [...DEFAULT_ANALYSIS_TEMPLATE.sections, COMPLIANCE_SECTION],
  });
}

describe("buildAnalysisSchema", () => {
  it("accepts a complete analysis for the default template", () => {
    const parsed = buildAnalysisSchema(DEFAULT_ANALYSIS_TEMPLATE).safeParse(validAnalysis());
    expect(parsed.success).toBe(true);
  });

  it("rejects a missing mandatory section (M43 fail-closed)", () => {
    const doc = validAnalysis();
    delete doc.sections["acceptanceCriteria"];
    const parsed = buildAnalysisSchema(DEFAULT_ANALYSIS_TEMPLATE).safeParse(doc);
    expect(parsed.success).toBe(false);
  });

  it("allows an optional section to be omitted", () => {
    const doc = validAnalysis();
    delete doc.sections["uiApiChanges"];
    doc.sections["sources"] = (doc.sections["sources"] as { section: string }[]).filter(
      (s) => s.section !== "uiApiChanges",
    );
    expect(buildAnalysisSchema(DEFAULT_ANALYSIS_TEMPLATE).safeParse(doc).success).toBe(true);
  });

  it("rejects a section the template does not declare", () => {
    const doc = validAnalysis();
    doc.sections["smuggled"] = "kaçak bölüm";
    expect(buildAnalysisSchema(DEFAULT_ANALYSIS_TEMPLATE).safeParse(doc).success).toBe(false);
  });

  it("refuses an empty Kaynaklar list at the schema itself (M109)", () => {
    const doc = validAnalysis();
    doc.sections["sources"] = [];
    expect(buildAnalysisSchema(DEFAULT_ANALYSIS_TEMPLATE).safeParse(doc).success).toBe(false);
  });

  it("enforces the minimum item count a section declares", () => {
    const doc = validAnalysis();
    doc.sections["acceptanceCriteria"] = ["tek madde"];
    expect(buildAnalysisSchema(DEFAULT_ANALYSIS_TEMPLATE).safeParse(doc).success).toBe(false);
  });

  it("refuses to build a schema for a template without traceability", () => {
    const noSources = AnalysisTemplate.parse({
      ...DEFAULT_ANALYSIS_TEMPLATE,
      sections: DEFAULT_ANALYSIS_TEMPLATE.sections.filter((s) => s.format !== "source_list"),
    });
    expect(() => buildAnalysisSchema(noSources)).toThrow(TemplateError);
  });

  it("changes with the template, not with the code (M108)", () => {
    const before = validAnalysis();
    const extended = withCompliance();

    // The same document that passed the v3 schema fails the v4 schema…
    expect(buildAnalysisSchema(DEFAULT_ANALYSIS_TEMPLATE).safeParse(before).success).toBe(true);
    expect(buildAnalysisSchema(extended).safeParse(before).success).toBe(false);

    // …and passes once the new section is filled in. No source file changed.
    const after = validAnalysis();
    after.sections["compliance"] = "KVKK açısından yeni kişisel veri işlenmiyor.";
    expect(buildAnalysisSchema(extended).safeParse(after).success).toBe(true);
  });

  it("pins the template version in the schema name (M83)", () => {
    expect(analysisSchemaName(DEFAULT_ANALYSIS_TEMPLATE)).toBe("AnalysisDoc@kurumsal-analiz@v3");
    expect(analysisSchemaName(withCompliance())).toBe("AnalysisDoc@kurumsal-analiz@v4");
  });
});
