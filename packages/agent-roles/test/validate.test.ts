import { describe, expect, it } from "vitest";
import { buildReferenceIndex, isKnownReference } from "../src/context.js";
import type { SourceEntry } from "../src/schema-builder.js";
import { DEFAULT_ANALYSIS_TEMPLATE } from "../src/template.js";
import { fold } from "../src/substance.js";
import { type Deficiency, overusedReferences, validateAnalysis } from "../src/validate.js";
import { analysisContext, validAnalysis } from "./fixtures.js";

const template = DEFAULT_ANALYSIS_TEMPLATE;
const context = analysisContext();

function check(mutate: (doc: ReturnType<typeof validAnalysis>) => void): Deficiency[] {
  const value = validAnalysis();
  mutate(value);
  const result = validateAnalysis({ template, context, value });
  return result.ok ? [] : result.deficiencies;
}

function sources(doc: ReturnType<typeof validAnalysis>): SourceEntry[] {
  return doc.sections["sources"] as SourceEntry[];
}

describe("validateAnalysis", () => {
  it("passes a complete, fully sourced analysis", () => {
    const result = validateAnalysis({ template, context, value: validAnalysis() });
    expect(result.ok).toBe(true);
  });

  it("names the missing section in Turkish (M43)", () => {
    const deficiencies = check((doc) => {
      delete doc.sections["riskAndRollback"];
    });
    expect(deficiencies.map((d) => d.code)).toContain("section_missing");
    expect(deficiencies[0]?.message).toContain("Risk ve geri dönüş planı");
  });

  it("refuses an analysis whose Kaynaklar section is empty (M109)", () => {
    const deficiencies = check((doc) => {
      doc.sections["sources"] = [];
    });
    expect(deficiencies.length).toBeGreaterThan(0);
    expect(JSON.stringify(deficiencies)).toContain("Kaynaklar");
  });

  it("refuses a claim section that no source backs", () => {
    const deficiencies = check((doc) => {
      doc.sections["sources"] = sources(doc).filter((s) => s.section !== "testApproach");
    });
    expect(deficiencies.map((d) => d.code)).toEqual(["section_unsourced"]);
    expect(deficiencies[0]?.message).toContain("Test yaklaşımı");
  });

  it("catches a fabricated reference — the file was never shown to the role (M98)", () => {
    const deficiencies = check((doc) => {
      const first = sources(doc)[0];
      if (first) {
        first.kind = "repo_file";
        first.ref = "src/credit/does-not-exist.ts";
      }
    });
    expect(deficiencies.map((d) => d.code)).toContain("source_fabricated");
    expect(deficiencies[0]?.message).toContain("src/credit/does-not-exist.ts");
  });

  it("accepts a repo card module path as a reference", () => {
    const deficiencies = check((doc) => {
      const entry = sources(doc).find((s) => s.section === "impactMatrix");
      if (entry) entry.ref = "Sources/Kredi";
    });
    expect(deficiencies).toEqual([]);
  });

  it("catches a source pointing at a section the template does not have", () => {
    const deficiencies = check((doc) => {
      const first = sources(doc)[0];
      if (first) first.section = "hayaliBolum";
    });
    expect(deficiencies.map((d) => d.code)).toContain("source_unknown_section");
  });

  it("catches placeholder text that only looks like content", () => {
    const deficiencies = check((doc) => {
      doc.sections["testApproach"] = "TODO: test yaklaşımı sonra yazılacak.";
    });
    expect(deficiencies.map((d) => d.code)).toContain("placeholder");
  });

  it("finds placeholders nested inside lists and field groups", () => {
    const deficiencies = check((doc) => {
      (doc.sections["riskAndRollback"] as Record<string, string>)["rollback"] = "TBD";
    });
    expect(deficiencies.map((d) => d.code)).toContain("placeholder");
  });

  it("reports schema problems with their path", () => {
    const deficiencies = check((doc) => {
      doc.sections["acceptanceCriteria"] = ["yalnız bir madde"];
    });
    expect(deficiencies[0]?.code).toBe("schema");
    expect(deficiencies[0]?.message).toContain("sections.acceptanceCriteria");
  });

  it("does not demand a source for an optional section that was skipped", () => {
    const deficiencies = check((doc) => {
      delete doc.sections["uiApiChanges"];
      doc.sections["sources"] = sources(doc).filter((s) => s.section !== "uiApiChanges");
    });
    expect(deficiencies).toEqual([]);
  });
});

describe("few-shot example analyses are citable (M109 false positive)", () => {
  // The prompt SHOWS `exampleAnalyses` to the model. A reference index that
  // omitted them refused a legitimate citation as `source_fabricated`, and the
  // repair round could not explain why — the document was in front of the model.
  it("indexes example analyses under knowledge_doc", () => {
    const index = buildReferenceIndex(context);
    expect(isKnownReference(index, "knowledge_doc", "ornek-analiz.md")).toBe(true);
  });

  it("accepts an analysis that cites an example analysis by name", () => {
    const deficiencies = check((doc) => {
      const entry = sources(doc).find((s) => s.section === "testApproach");
      if (entry) {
        entry.kind = "knowledge_doc";
        entry.ref = "ornek-analiz.md";
      }
    });
    expect(deficiencies).toEqual([]);
  });

  it("keeps rejecting a knowledge doc name that was never shown", () => {
    const index = buildReferenceIndex(context);
    expect(isKnownReference(index, "knowledge_doc", "hic-verilmeyen-ornek.md")).toBe(false);
  });
});

describe("placeholder scan is Turkish-aware (M43)", () => {
  // Every one of these passed the English-only pattern in the verifier's run:
  // the model writes them, the sources look right, and a human gate ends up
  // reading an empty section.
  const turkishEscapes = [
    "…",
    "...",
    "-",
    "—",
    "x",
    "yukarıdaki gibi",
    "Yukarıdaki Gibi",
    "Yok",
    "yok.",
    "belirtilmemiş",
    "bilinmiyor",
    "bilgi yok",
    "geçerli değil",
    "doldurulacak",
    "sonra yazılacak",
    "ilgili değil",
    "aynı",
  ];

  for (const escape of turkishEscapes) {
    it(`refuses "${escape}" as a section body`, () => {
      const deficiencies = check((doc) => {
        doc.sections["testApproach"] = escape;
      });
      expect(deficiencies.map((d) => d.code)).toContain("placeholder");
    });
  }

  it("finds a Turkish placeholder nested inside a field group", () => {
    const deficiencies = check((doc) => {
      (doc.sections["riskAndRollback"] as Record<string, string>)["rollback"] = "belirtilmemiş";
    });
    expect(deficiencies.map((d) => d.code)).toContain("placeholder");
  });

  it("condemns a TODO marker even when a sentence is wrapped around it", () => {
    const deficiencies = check((doc) => {
      doc.sections["testApproach"] =
        "Birim testleri yazılacak. TODO: kapsam eşiğini sonra netleştireceğim.";
    });
    expect(deficiencies.map((d) => d.code)).toContain("placeholder");
  });

  it("leaves row-shaped formats alone, where a dash is a real answer", () => {
    // "Geriye uyum: -" in a table means "not applicable", not an evasion.
    // Refusing valid documents is the same failure as passing invalid ones.
    const deficiencies = check((doc) => {
      doc.sections["uiApiChanges"] = [
        { Yüzey: "POST /api/credit/limit", Durum: "yeni", "Geriye uyum": "-" },
      ];
    });
    expect(deficiencies).toEqual([]);
  });

  it("still accepts real prose that merely mentions a placeholder-like word", () => {
    const deficiencies = check((doc) => {
      doc.sections["testApproach"] =
        "Birim testleri limit doğrulama kurallarını kapsar. Kapsam eşiği %70 altına düşerse yapı kırmızıya döner.";
    });
    expect(deficiencies).toEqual([]);
  });
});

describe("free_text substance floor (M43)", () => {
  // The template PROMISES "en az iki cümlelik düz paragraf" in bicim.free_text.
  // Nothing enforced it, so a single terse clause satisfied the schema.
  it("refuses a one-word free_text section", () => {
    const deficiencies = check((doc) => {
      doc.sections["purpose"] = "Limit";
    });
    expect(deficiencies.map((d) => d.code)).toContain("too_short");
  });

  it("refuses a free_text section that is a single short sentence", () => {
    const deficiencies = check((doc) => {
      doc.sections["testApproach"] = "Testler yazılır.";
    });
    expect(deficiencies.map((d) => d.code)).toContain("too_short");
  });

  it("names the section in the deficiency so the repair round is actionable", () => {
    const deficiencies = check((doc) => {
      doc.sections["testApproach"] = "Kısa.";
    });
    const short = deficiencies.find((d) => d.code === "too_short");
    expect(short?.message).toContain("Test yaklaşımı");
  });

  it("accepts a two-sentence paragraph", () => {
    const deficiencies = check((doc) => {
      doc.sections["testApproach"] =
        "Birim testleri doğrulama kurallarını kapsar. Entegrasyon testleri ucu ve eşzamanlılığı kapsar.";
    });
    expect(deficiencies).toEqual([]);
  });

  it("does not impose the floor on non-free_text formats", () => {
    const deficiencies = check((doc) => {
      doc.sections["acceptanceCriteria"] = ["Kısa madde.", "İkinci madde.", "Üçüncü madde."];
      doc.sections["scope"] = { included: ["Uç"], excluded: ["Mobil"] };
    });
    expect(deficiencies).toEqual([]);
  });
});

describe("copied template text is not an answer (M43)", () => {
  it("refuses a section whose body is its own title", () => {
    const deficiencies = check((doc) => {
      doc.sections["testApproach"] = "Test yaklaşımı";
    });
    expect(deficiencies.map((d) => d.code)).toContain("template_echo");
  });

  it("refuses a section whose body is its own AI instruction, verbatim", () => {
    const instruction = template.sections.find((s) => s.key === "testApproach")?.aiInstruction ?? "";
    const deficiencies = check((doc) => {
      doc.sections["testApproach"] = instruction;
    });
    expect(deficiencies.map((d) => d.code)).toContain("template_echo");
  });

  it("refuses a copied description too, ignoring case and surrounding space", () => {
    const description = template.sections.find((s) => s.key === "purpose")?.description ?? "";
    const deficiencies = check((doc) => {
      doc.sections["purpose"] = `  ${description.toUpperCase()}  `;
    });
    expect(deficiencies.map((d) => d.code)).toContain("template_echo");
  });

  it("folds Turkish dotted and dotless i so shouting does not evade the check", () => {
    // "İ".toLowerCase() and "I".toLocaleLowerCase("tr") disagree; without an
    // explicit fold, an all-caps copy of the instruction slips through.
    expect(fold("İŞİN NEDEN")).toBe(fold("işin neden"));
    expect(fold("IŞIN")).toBe(fold("işin"));
  });

  it("catches an echoed title nested in a bullet list", () => {
    const deficiencies = check((doc) => {
      doc.sections["acceptanceCriteria"] = [
        "Limit üst sınırı konfigürasyondan okunur.",
        "Kabul kriterleri",
        "Başarılı artırım audit kaydına yazılır.",
      ];
    });
    expect(deficiencies.map((d) => d.code)).toContain("template_echo");
  });
});

describe("repeated reference signal (M109 limit)", () => {
  // Source checking proves a reference EXISTS, never that it is RELEVANT.
  // Relevance is the human gate's job; this is only a cheap smell.
  it("warns when one reference is cited across too many sections", () => {
    const value = validAnalysis();
    value.sections["sources"] = sources(value).map((s) => ({
      ...s,
      kind: "repo_file" as const,
      ref: "src/credit/limit-policy.ts",
    }));
    const result = validateAnalysis({ template, context, value });
    expect(result.ok).toBe(true);
    expect(overusedReferences(template, value)).toContainEqual(
      expect.objectContaining({ ref: "src/credit/limit-policy.ts" }),
    );
  });

  it("stays silent for a normally distributed source list", () => {
    expect(overusedReferences(template, validAnalysis())).toEqual([]);
  });
});
