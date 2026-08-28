import { describe, expect, it } from "vitest";
import { MissingPromptError } from "../src/errors.js";
import { buildAnalysisPrompt } from "../src/prompt.js";
import { AnalysisTemplate, DEFAULT_ANALYSIS_TEMPLATE } from "../src/template.js";
import { VARIANT_IDS, VariantId, resolveTemplate, resolveTexts } from "../src/variants.js";
import { analysisContext } from "./fixtures.js";

const context = analysisContext();

describe("variants (M38)", () => {
  it("knows the five variant ids", () => {
    expect(VARIANT_IDS).toEqual(["web", "mobile-ios", "mobile-android", "desktop", "backend"]);
    expect(VariantId.safeParse("mobile-ios").success).toBe(true);
    expect(VariantId.safeParse("mainframe").success).toBe(false);
  });

  it("rewrites prompt wording without touching code", () => {
    const texts = resolveTexts({
      textOverrides: {
        "analyst.sistem": "Sen bir iOS ekibinin analistisin.",
      },
    });
    const prompt = buildAnalysisPrompt({ template: DEFAULT_ANALYSIS_TEMPLATE, context, texts });
    expect(prompt.startsWith("Sen bir iOS ekibinin analistisin.")).toBe(true);
    // The default is untouched — overrides are per call, not global.
    expect(
      buildAnalysisPrompt({ template: DEFAULT_ANALYSIS_TEMPLATE, context }).startsWith(
        "Sen bir iOS",
      ),
    ).toBe(false);
  });

  it("refuses an override for a key that does not exist", () => {
    expect(() => resolveTexts({ textOverrides: { "analyst.sistemm": "typo" } })).toThrow(
      MissingPromptError,
    );
  });

  it("returns the defaults when there is no variant", () => {
    expect(resolveTexts()["analyst.sistem"]).toContain("kıdemli yazılım analisti");
  });

  it("lets a variant carry its own analysis template", () => {
    const mobileTemplate = AnalysisTemplate.parse({
      ...DEFAULT_ANALYSIS_TEMPLATE,
      templateId: "mobil-analiz",
      version: "v1",
    });
    expect(
      resolveTemplate(DEFAULT_ANALYSIS_TEMPLATE, {
        variantId: "mobile-ios",
        textOverrides: {},
        template: mobileTemplate,
      }).templateId,
    ).toBe("mobil-analiz");
    expect(
      resolveTemplate(DEFAULT_ANALYSIS_TEMPLATE, { variantId: "web", textOverrides: {} })
        .templateId,
    ).toBe("kurumsal-analiz");
  });
});
