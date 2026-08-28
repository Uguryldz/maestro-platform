import { describe, expect, it } from "vitest";
import {
  type AnalysisGoldenCase,
  type IntakeGoldenCase,
  aggregate,
  detectRegression,
  scoreAnalysis,
  scoreIntake,
} from "../src/eval.js";
import { IntakeOutput } from "../src/schemas.js";
import { DEFAULT_ANALYSIS_TEMPLATE } from "../src/template.js";
import { analysisContext, ticket, validAnalysis } from "./fixtures.js";

const golden: AnalysisGoldenCase = {
  caseId: "UGURPAY-501",
  context: analysisContext(),
  template: DEFAULT_ANALYSIS_TEMPLATE,
  expected: {
    requiredSections: ["purpose", "acceptanceCriteria", "sources"],
    impactedApps: ["ugurpay-api", "ugurmobil-ios"],
    riskTier: "orta",
    criteriaKeywords: [["422", "reddedil"], ["audit", "denetim"]],
  },
};

describe("scoreAnalysis", () => {
  it("gives a full score to the golden answer", () => {
    const score = scoreAnalysis(golden, validAnalysis());
    expect(score.failures).toEqual([]);
    expect(score.score).toBe(1);
  });

  it("is deterministic — the same inputs give the same score", () => {
    expect(scoreAnalysis(golden, validAnalysis())).toEqual(scoreAnalysis(golden, validAnalysis()));
  });

  it("reports a missed impacted application", () => {
    const output = validAnalysis();
    output.sections["impactMatrix"] = [
      {
        appId: "ugurpay-api",
        impacted: true,
        summary: "Yeni uç",
        source: "primary_repo_discovery",
      },
    ];
    const score = scoreAnalysis(golden, output);
    expect(score.failures).toContain('app "ugurmobil-ios" not marked impacted');
    expect(score.score).toBeLessThan(1);
  });

  it("reports a wrong risk tier and a missing meaning in the criteria", () => {
    const output = validAnalysis();
    output.riskTier = "dusuk";
    output.sections["acceptanceCriteria"] = ["a", "b", "c"];
    const score = scoreAnalysis(golden, output);
    expect(score.failures).toContain("risk tier dusuk != orta");
    expect(score.failures.some((f) => f.includes("422"))).toBe(true);
  });

  it("reports a sourceless answer", () => {
    const output = validAnalysis();
    output.sections["sources"] = [];
    expect(scoreAnalysis(golden, output).failures).toContain("no sources cited");
  });
});

describe("scoreIntake", () => {
  const goldenIntake: IntakeGoldenCase = {
    caseId: "UGURPAY-777",
    ticket: ticket({ key: "UGURPAY-777" }),
    expected: { complete: false, missingFields: ["üst sınır"] },
  };

  it("passes when the role asked about the expected gap", () => {
    const output = IntakeOutput.parse({
      complete: false,
      missing: [{ field: "Üst sınır değeri", why: "gerekli", question: "Üst sınır kaç?" }],
    });
    expect(scoreIntake(goldenIntake, output).failures).toEqual([]);
  });

  it("fails when the role declared a thin ticket complete", () => {
    const output = IntakeOutput.parse({ complete: true, missing: [] });
    const score = scoreIntake(goldenIntake, output);
    expect(score.failures).toContain("complete=true != false");
    expect(score.failures).toContain('no question about missing field "üst sınır"');
  });
});

describe("aggregate and detectRegression", () => {
  const baseline = aggregate([
    { caseId: "a", passed: 4, total: 4, score: 1, failures: [] },
    { caseId: "b", passed: 3, total: 4, score: 0.75, failures: ["x"] },
  ]);

  it("summarises pass rate and mean score", () => {
    expect(baseline.cases).toBe(2);
    expect(baseline.passRate).toBe(0.5);
    expect(baseline.meanScore).toBe(0.875);
  });

  it("treats an empty run as vacuously passing", () => {
    expect(aggregate([])).toEqual({ cases: 0, passRate: 1, meanScore: 1, perCase: [] });
  });

  it("flags a candidate that scores lower on a case (M78)", () => {
    const candidate = aggregate([
      { caseId: "a", passed: 2, total: 4, score: 0.5, failures: ["y", "z"] },
      { caseId: "b", passed: 3, total: 4, score: 0.75, failures: ["x"] },
    ]);
    const report = detectRegression(baseline, candidate);
    expect(report.regressed).toBe(true);
    expect(report.degradedCases).toEqual(["a"]);
    expect(report.passRateDelta).toBe(-0.5);
  });

  it("accepts an improvement", () => {
    const candidate = aggregate([
      { caseId: "a", passed: 4, total: 4, score: 1, failures: [] },
      { caseId: "b", passed: 4, total: 4, score: 1, failures: [] },
    ]);
    const report = detectRegression(baseline, candidate);
    expect(report.regressed).toBe(false);
    expect(report.passRateDelta).toBe(0.5);
  });

  it("honours a tolerance for noise", () => {
    const candidate = aggregate([
      { caseId: "a", passed: 4, total: 4, score: 0.95, failures: [] },
      { caseId: "b", passed: 3, total: 4, score: 0.75, failures: ["x"] },
    ]);
    expect(detectRegression(baseline, candidate, 0.1).regressed).toBe(false);
    expect(detectRegression(baseline, candidate, 0).regressed).toBe(true);
  });
});
