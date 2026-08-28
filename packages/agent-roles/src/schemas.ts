import { z } from "zod";
import { NonEmpty } from "@maestro/contracts";

/**
 * Output schemas of the thinking roles other than the analyst. The analyst's
 * schema is generated from the template (M108); these four are fixed, because
 * their shape is a workflow contract rather than a corporate document.
 *
 * Cross-field rules (a `complete` intake with open questions, an `approved`
 * review with blockers) deliberately live in the validators, not here: the
 * validators can phrase them in Turkish and hand them to the repair round,
 * while a schema issue would only say "invalid".
 */

// ── step 2: intake (M98) ───────────────────────────────────────────────────

/**
 * Note what is absent, never fill it in. There is no field on this object that
 * could carry an invented value — the only thing the role may produce about a
 * gap is a question for the reporter.
 */
export const MissingField = z
  .object({
    field: NonEmpty,
    why: NonEmpty,
    question: NonEmpty,
  })
  .strict();
export type MissingField = z.infer<typeof MissingField>;

export const IntakeOutput = z
  .object({
    complete: z.boolean(),
    missing: z.array(MissingField).default([]),
  })
  .strict();
export type IntakeOutput = z.infer<typeof IntakeOutput>;

// ── step 6c: dev reviewer ──────────────────────────────────────────────────

export const ReviewSeverity = z.enum(["blocker", "major", "minor", "nit"]);
export type ReviewSeverity = z.infer<typeof ReviewSeverity>;

export const BLOCKING_SEVERITIES: readonly ReviewSeverity[] = ["blocker", "major"];

export const ReviewFinding = z
  .object({
    /** Path exactly as it appears in the reviewed diff. */
    file: NonEmpty,
    /** Line number or hunk header the finding points at. */
    locator: NonEmpty,
    severity: ReviewSeverity,
    problem: NonEmpty,
    suggestion: NonEmpty,
  })
  .strict();
export type ReviewFinding = z.infer<typeof ReviewFinding>;

export const DevReviewOutput = z
  .object({
    approved: z.boolean(),
    summary: NonEmpty,
    findings: z.array(ReviewFinding).default([]),
  })
  .strict();
export type DevReviewOutput = z.infer<typeof DevReviewOutput>;

// ── step 7: test designer ──────────────────────────────────────────────────

export const TestKind = z.enum(["unit", "integration", "e2e"]);
export type TestKind = z.infer<typeof TestKind>;

export const GherkinScenario = z
  .object({
    title: NonEmpty,
    /** 1-based index into the analysis acceptance criteria — the coverage link. */
    criterionIndex: z.number().int().positive(),
    kind: TestKind,
    tags: z.array(NonEmpty).default([]),
    given: z.array(NonEmpty).min(1),
    when: z.array(NonEmpty).min(1),
    then: z.array(NonEmpty).min(1),
    negative: z.boolean(),
  })
  .strict();
export type GherkinScenario = z.infer<typeof GherkinScenario>;

export const TestDesignOutput = z
  .object({
    feature: NonEmpty,
    scenarios: z.array(GherkinScenario).min(1),
  })
  .strict();
export type TestDesignOutput = z.infer<typeof TestDesignOutput>;

// ── step 8: test reviewer (4 eyes) ─────────────────────────────────────────

export const TestReviewFinding = z
  .object({
    scenarioTitle: NonEmpty.nullable().default(null),
    criterionIndex: z.number().int().positive().nullable().default(null),
    severity: ReviewSeverity,
    problem: NonEmpty,
  })
  .strict();
export type TestReviewFinding = z.infer<typeof TestReviewFinding>;

export const TestReviewOutput = z
  .object({
    approved: z.boolean(),
    uncoveredCriteria: z.array(z.number().int().positive()).default([]),
    findings: z.array(TestReviewFinding).default([]),
  })
  .strict();
export type TestReviewOutput = z.infer<typeof TestReviewOutput>;

/** Turkish Gherkin, for the Jira comment and the evidence package (M47/M59). */
export function renderGherkin(design: TestDesignOutput): string {
  const scenarios = design.scenarios.map((s) => {
    const tags = s.tags.length > 0 ? `${s.tags.map((t) => `@${t}`).join(" ")}\n` : "";
    const lines = [
      ...s.given.map((g, i) => `    ${i === 0 ? "Diyelim ki" : "Ve"} ${g}`),
      ...s.when.map((w, i) => `    ${i === 0 ? "Eğer" : "Ve"} ${w}`),
      ...s.then.map((t, i) => `    ${i === 0 ? "O zaman" : "Ve"} ${t}`),
    ];
    return `${tags}  Senaryo: ${s.title}\n${lines.join("\n")}`;
  });
  return `Özellik: ${design.feature}\n\n${scenarios.join("\n\n")}`;
}
