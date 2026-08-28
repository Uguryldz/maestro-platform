import type { RiskTier, TicketSnapshot } from "@maestro/contracts";
import type { AnalysisContext } from "./context.js";
import type { AnalysisOutput, SourceEntry } from "./schema-builder.js";
import type { IntakeOutput } from "./schemas.js";
import { type AnalysisTemplate, sourceSection } from "./template.js";

/**
 * Golden-ticket evaluation hook (M78).
 *
 * A model, persona or template change needs an eval run before it may be
 * approved. Wave 4 wires the runner (Studio screen + stored golden set); what
 * lives here is the SHAPE plus the scoring, and the scoring is pure: same
 * inputs, same score, no clock, no I/O, no model. That is what makes a
 * regression comparison meaningful rather than a re-roll.
 */

export interface AnalysisExpectation {
  /** Section keys that must be present and non-empty. */
  requiredSections: string[];
  /** Apps the impact matrix must mark as impacted. */
  impactedApps: string[];
  riskTier?: RiskTier;
  /**
   * Each group is a set of synonyms; the acceptance criteria must contain at
   * least one member of every group. Wording is free, meaning is not.
   */
  criteriaKeywords: string[][];
}

export interface AnalysisGoldenCase {
  caseId: string;
  context: AnalysisContext;
  template: AnalysisTemplate;
  expected: AnalysisExpectation;
}

export interface IntakeExpectation {
  complete: boolean;
  /** Fields the role is expected to notice as missing. */
  missingFields: string[];
}

export interface IntakeGoldenCase {
  caseId: string;
  ticket: TicketSnapshot;
  expected: IntakeExpectation;
}

export interface EvalScore {
  caseId: string;
  passed: number;
  total: number;
  /** passed / total, 1 when there is nothing to check. */
  score: number;
  failures: string[];
}

export interface EvalSummary {
  cases: number;
  passRate: number;
  meanScore: number;
  perCase: EvalScore[];
}

/** Implemented in wave 4 (Studio eval screen); the shape is frozen here. */
export interface RoleEvaluator {
  evaluateAnalysis(cases: readonly AnalysisGoldenCase[]): Promise<EvalSummary>;
  evaluateIntake(cases: readonly IntakeGoldenCase[]): Promise<EvalSummary>;
}

function score(caseId: string, checks: readonly { ok: boolean; failure: string }[]): EvalScore {
  const failures = checks.filter((c) => !c.ok).map((c) => c.failure);
  const passed = checks.length - failures.length;
  return {
    caseId,
    passed,
    total: checks.length,
    score: checks.length === 0 ? 1 : passed / checks.length,
    failures,
  };
}

function isFilled(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export function scoreAnalysis(golden: AnalysisGoldenCase, output: AnalysisOutput): EvalScore {
  const checks: { ok: boolean; failure: string }[] = [];

  for (const key of golden.expected.requiredSections) {
    checks.push({
      ok: isFilled(output.sections[key]),
      failure: `section "${key}" missing or empty`,
    });
  }

  const matrixSection = golden.template.sections.find((s) => s.format === "impact_matrix");
  const cells = matrixSection
    ? ((output.sections[matrixSection.key] ?? []) as { appId: string; impacted: boolean }[])
    : [];
  const impacted = new Set(cells.filter((c) => c.impacted).map((c) => c.appId));
  for (const app of golden.expected.impactedApps) {
    checks.push({ ok: impacted.has(app), failure: `app "${app}" not marked impacted` });
  }

  if (golden.expected.riskTier) {
    checks.push({
      ok: output.riskTier === golden.expected.riskTier,
      failure: `risk tier ${output.riskTier} != ${golden.expected.riskTier}`,
    });
  }

  const criteriaSection = golden.template.sections.find(
    (s) => s.contractField === "acceptanceCriteria",
  );
  const criteria = criteriaSection
    ? ((output.sections[criteriaSection.key] ?? []) as string[]).join(" ").toLocaleLowerCase("tr")
    : "";
  for (const group of golden.expected.criteriaKeywords) {
    checks.push({
      ok: group.some((k) => criteria.includes(k.toLocaleLowerCase("tr"))),
      failure: `no acceptance criterion mentions any of: ${group.join(" / ")}`,
    });
  }

  const sources = sourceSection(golden.template);
  const entries = sources ? ((output.sections[sources.key] ?? []) as SourceEntry[]) : [];
  checks.push({ ok: entries.length > 0, failure: "no sources cited" });

  return score(golden.caseId, checks);
}

export function scoreIntake(golden: IntakeGoldenCase, output: IntakeOutput): EvalScore {
  const checks = [
    {
      ok: output.complete === golden.expected.complete,
      failure: `complete=${output.complete} != ${golden.expected.complete}`,
    },
  ];
  const asked = output.missing.map((m) => m.field.toLocaleLowerCase("tr"));
  for (const field of golden.expected.missingFields) {
    checks.push({
      ok: asked.some((a) => a.includes(field.toLocaleLowerCase("tr"))),
      failure: `no question about missing field "${field}"`,
    });
  }
  return score(golden.caseId, checks);
}

export function aggregate(scores: readonly EvalScore[]): EvalSummary {
  const cases = scores.length;
  if (cases === 0) return { cases: 0, passRate: 1, meanScore: 1, perCase: [] };
  const fullyPassed = scores.filter((s) => s.failures.length === 0).length;
  return {
    cases,
    passRate: fullyPassed / cases,
    meanScore: scores.reduce((sum, s) => sum + s.score, 0) / cases,
    perCase: [...scores],
  };
}

export interface RegressionReport {
  regressed: boolean;
  passRateDelta: number;
  meanScoreDelta: number;
  /** Cases that scored lower than in the baseline. */
  degradedCases: string[];
}

/**
 * Compare a candidate run against the approved baseline (M78). A drop beyond
 * `tolerance` is a regression, and a regression needs a written justification
 * plus a second approver — this function only states the fact.
 */
export function detectRegression(
  baseline: EvalSummary,
  candidate: EvalSummary,
  tolerance = 0,
): RegressionReport {
  const byId = new Map(baseline.perCase.map((c) => [c.caseId, c.score]));
  const degradedCases = candidate.perCase
    .filter((c) => c.score < (byId.get(c.caseId) ?? c.score) - tolerance)
    .map((c) => c.caseId);
  const passRateDelta = candidate.passRate - baseline.passRate;
  const meanScoreDelta = candidate.meanScore - baseline.meanScore;
  return {
    regressed: degradedCases.length > 0 || passRateDelta < -tolerance,
    passRateDelta,
    meanScoreDelta,
    degradedCases,
  };
}
