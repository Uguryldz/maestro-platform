import { describe, expect, it } from "vitest";
import { renderAnalysisMarkdown, renderSectionValue } from "../src/render.js";
import { DEFAULT_ANALYSIS_TEMPLATE, sectionByKey } from "../src/template.js";
import { validAnalysis } from "./fixtures.js";

const template = DEFAULT_ANALYSIS_TEMPLATE;
const output = validAnalysis();

function render(key: string): string {
  const section = sectionByKey(template, key);
  if (!section) throw new Error(`no section ${key}`);
  return renderSectionValue(section, output.sections[key]);
}

describe("renderSectionValue", () => {
  it("renders a bullet list", () => {
    expect(render("acceptanceCriteria")).toContain("- Limit üst sınırı konfigürasyondan okunur.");
  });

  it("renders a list group under its sub-list labels", () => {
    const text = render("scope");
    expect(text).toContain("**Dahil**");
    expect(text).toContain("**Hariç**");
    expect(text).toContain("- mobil ekranlar");
  });

  it("renders a field group as labelled paragraphs", () => {
    expect(render("riskAndRollback")).toContain("**Geri dönüş:** Özellik bayrağı kapatılır.");
  });

  it("renders the impact matrix as a table with a Turkish yes/no column", () => {
    const text = render("impactMatrix");
    expect(text).toContain("| Uygulama | Etkileniyor | Özet | Kaynak |");
    expect(text).toContain("| ugurmobil-ios | evet |");
  });

  it("renders the sources table (M109)", () => {
    const text = render("sources");
    expect(text).toContain("| Bölüm | İddia | Tür | Referans |");
    expect(text).toContain("src/credit/limit-policy.ts");
  });

  it("says so when there are no open items", () => {
    expect(render("openItems")).toBe("(boş)");
  });

  it("uses the 'no change' wording for an absent optional section", () => {
    const section = sectionByKey(template, "uiApiChanges");
    expect(renderSectionValue(section!, undefined)).toBe("Değişiklik yok.");
  });
});

describe("renderAnalysisMarkdown", () => {
  const markdown = renderAnalysisMarkdown(template, output);

  it("numbers the sections in template order", () => {
    expect(markdown).toContain("## 1. Amaç / iş değeri");
    expect(markdown).toContain("## 7. Risk ve geri dönüş planı");
    expect(markdown).toContain("## 9. Netleştirilecek açık maddeler");
  });

  it("closes with the pinned template version and the risk decision (M83)", () => {
    expect(markdown).toContain("**Risk seviyesi:** orta");
    expect(markdown).toContain("**Şablon sürümü:** Kurumsal analiz şablonu v3");
  });
});
