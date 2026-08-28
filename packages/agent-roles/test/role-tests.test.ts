import { describe, expect, it } from "vitest";
import { RoleOutputError } from "../src/errors.js";
import {
  type TestDesignContext,
  buildTestDesignPrompt,
  buildTestReviewPrompt,
  runTestDesigner,
  runTestReviewer,
  toTestReviewResult,
  uncoveredCriteria,
  validateTestDesign,
  validateTestReview,
} from "../src/role-tests.js";
import { TestDesignOutput, TestReviewOutput, renderGherkin } from "../src/schemas.js";
import { scriptedLlm, ticket } from "./fixtures.js";

const criteria = [
  "Limit üst sınırı konfigürasyondan okunur.",
  "Üst sınırı aşan talep 422 ile reddedilir.",
];

const context: TestDesignContext = {
  ticket: ticket(),
  acceptanceCriteria: criteria,
  testApproach: "Birim 20, entegrasyon 6.",
};

function scenario(criterionIndex: number, negative: boolean) {
  return {
    title: negative ? `Kriter ${criterionIndex} — ret` : `Kriter ${criterionIndex} — mutlu yol`,
    criterionIndex,
    kind: "integration" as const,
    tags: ["limit"],
    given: ["müşteri oturum açmış"],
    when: [negative ? "üst sınırın üzerinde limit ister" : "geçerli bir limit ister"],
    then: [negative ? "422 döner" : "limit güncellenir"],
    negative,
  };
}

const design = {
  feature: "Kredi limiti self-servis artırma",
  scenarios: [scenario(1, false), scenario(2, true)],
};

describe("test design", () => {
  it("numbers the criteria in the prompt so scenarios can point at them", () => {
    const prompt = buildTestDesignPrompt(context);
    expect(prompt).toContain("1. Limit üst sınırı konfigürasyondan okunur.");
    expect(prompt).toContain("2. Üst sınırı aşan talep 422 ile reddedilir.");
    expect(prompt).toContain("Birim 20, entegrasyon 6.");
  });

  it("accepts a design that covers every criterion and has a negative case", () => {
    expect(validateTestDesign(design, context).ok).toBe(true);
  });

  it("refuses a design that leaves a criterion uncovered", () => {
    const partial = { ...design, scenarios: [scenario(1, true)] };
    const result = validateTestDesign(partial, context);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.deficiencies[0]?.code).toBe("criterion_uncovered");
    expect(result.deficiencies[0]?.message).toContain("2 numaralı");
  });

  it("refuses a scenario pointing at a criterion that does not exist", () => {
    const invented = { ...design, scenarios: [...design.scenarios, scenario(9, false)] };
    const result = validateTestDesign(invented, context);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.deficiencies.map((d) => d.code)).toContain("criterion_out_of_range");
  });

  it("refuses a happy-path-only design", () => {
    const sunny = { ...design, scenarios: [scenario(1, false), scenario(2, false)] };
    const result = validateTestDesign(sunny, context);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.deficiencies.map((d) => d.code)).toContain("no_negative");
  });

  it("repairs an uncovered criterion and fails closed when every attempt stays partial", async () => {
    const partial = { ...design, scenarios: [scenario(1, true)] };
    const { llm, prompts } = scriptedLlm([partial, design]);
    const result = await runTestDesigner({
      llm,
      context,
      variantId: "web",
      dataClass: "dahili",
    });
    expect(result.status).toBe("ok");
    expect(prompts[1]).toContain("2 numaralı kabul kriterini karşılayan senaryo yok");

    const stubborn = scriptedLlm([partial, partial, partial]);
    await expect(
      runTestDesigner({ llm: stubborn.llm, context, variantId: "web", dataClass: "dahili" }),
    ).rejects.toBeInstanceOf(RoleOutputError);
  });
});

describe("test review (4 eyes)", () => {
  const reviewContext = { acceptanceCriteria: criteria, design: TestDesignOutput.parse(design) };

  it("shows the reviewer the scenarios it must audit", () => {
    const prompt = buildTestReviewPrompt(reviewContext);
    expect(prompt).toContain("Kriter 1 — mutlu yol");
    expect(prompt).toContain("kriter 2");
    expect(prompt).toContain("O zaman 422 döner");
  });

  it("accepts an approval when coverage really is complete", () => {
    const result = validateTestReview(
      { approved: true, uncoveredCriteria: [], findings: [] },
      reviewContext,
    );
    expect(result.ok).toBe(true);
  });

  it("refuses a reviewer that misses a real gap — the audit is recomputed", () => {
    const gapped = {
      acceptanceCriteria: criteria,
      design: TestDesignOutput.parse({ ...design, scenarios: [scenario(1, true)] }),
    };
    const result = validateTestReview(
      { approved: true, uncoveredCriteria: [], findings: [] },
      gapped,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.deficiencies.map((d) => d.code)).toContain("coverage_report_wrong");
  });

  it("refuses a reviewer that invents a gap", () => {
    const result = validateTestReview(
      { approved: false, uncoveredCriteria: [2], findings: [] },
      reviewContext,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.deficiencies.map((d) => d.code)).toContain("coverage_report_extra");
  });

  it("refuses an approval that admits an uncovered criterion", () => {
    const gapped = {
      acceptanceCriteria: criteria,
      design: TestDesignOutput.parse({ ...design, scenarios: [scenario(1, true)] }),
    };
    const result = validateTestReview(
      { approved: true, uncoveredCriteria: [2], findings: [] },
      gapped,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.deficiencies.map((d) => d.code)).toContain("approval_contradiction");
  });

  it("runs end to end through the port", async () => {
    const { llm } = scriptedLlm([{ approved: true, uncoveredCriteria: [], findings: [] }]);
    const result = await runTestReviewer({
      llm,
      context: reviewContext,
      variantId: "web",
      dataClass: "dahili",
    });
    expect(result.status).toBe("ok");
  });
});

describe("uncoveredCriteria", () => {
  it("lists the 1-based criteria no scenario claims", () => {
    expect(uncoveredCriteria(TestDesignOutput.parse(design), 3)).toEqual([3]);
    expect(uncoveredCriteria(TestDesignOutput.parse(design), 2)).toEqual([]);
  });
});

describe("renderGherkin", () => {
  it("writes Turkish Gherkin for the Jira comment (M59)", () => {
    const text = renderGherkin(TestDesignOutput.parse(design));
    expect(text).toContain("Özellik: Kredi limiti self-servis artırma");
    expect(text).toContain("@limit");
    expect(text).toContain("  Senaryo: Kriter 1 — mutlu yol");
    expect(text).toContain("    Diyelim ki müşteri oturum açmış");
    expect(text).toContain("    Eğer geçerli bir limit ister");
    expect(text).toContain("    O zaman limit güncellenir");
  });
});

describe("toTestReviewResult", () => {
  it("maps findings onto the workflow activity shape", () => {
    const output = TestReviewOutput.parse({
      approved: false,
      uncoveredCriteria: [2],
      findings: [{ criterionIndex: 2, severity: "major", problem: "Ret yolu test edilmiyor." }],
    });
    expect(toTestReviewResult(output)).toEqual({
      approved: false,
      findings: ["[major] kriter 2 — Ret yolu test edilmiyor."],
    });
  });
});
