import type { DataClass, TicketSnapshot } from "@maestro/contracts";
import type { LlmPort } from "@maestro/ports";
import { block, bullets } from "./prompt.js";
import type { ReviewActivityResult } from "./role-dev-reviewer.js";
import { type RoleResult, runRole } from "./run.js";
import { TestDesignOutput, TestReviewOutput } from "./schemas.js";
import { DEFAULT_PROMPT_TEXTS, type PromptTexts, text } from "./texts.js";
import type { Deficiency, Validation } from "./validate.js";

/**
 * Steps 7 and 8 — test designer and test reviewer (4 eyes, M17).
 *
 * The two roles are bound to the acceptance criteria by index, which makes
 * coverage a computable fact instead of an opinion: the designer must cover
 * every criterion, and the reviewer's coverage report is checked against the
 * scenarios rather than taken on trust.
 */

export interface TestDesignContext {
  ticket: TicketSnapshot;
  acceptanceCriteria: string[];
  testApproach: string;
}

function schemaDeficiencies(
  issues: readonly { path: PropertyKey[]; message: string }[],
  texts: PromptTexts,
): Deficiency[] {
  return issues.map((i) => ({
    code: "schema",
    message: text(texts, "eksik.semaHatasi", {
      yol: i.path.map(String).join(".") || "<kök>",
      mesaj: i.message,
    }),
  }));
}

function criteriaBlock(criteria: readonly string[], texts: PromptTexts): string {
  return block(
    text(texts, "testDesigner.baslik.kabulKriterleri"),
    bullets(
      criteria.map((c, i) => `${i + 1}. ${c}`),
      text(texts, "ortak.baglamBos"),
    ),
  );
}

function rulesBlock(roleKey: string, texts: PromptTexts): string {
  return block(
    text(texts, "ortak.baslik.kurallar"),
    bullets(
      [
        text(texts, "ortak.dil"),
        text(texts, "ortak.uydurmaYasak"),
        text(texts, `${roleKey}.kurallar`),
        text(texts, "ortak.ciktiBicimi"),
      ],
      "-",
    ),
  );
}

export function buildTestDesignPrompt(
  context: TestDesignContext,
  texts: PromptTexts = DEFAULT_PROMPT_TEXTS,
): string {
  return [
    text(texts, "testDesigner.sistem"),
    rulesBlock("testDesigner", texts),
    block(text(texts, "ortak.baslik.ticket"), `${context.ticket.key} · ${context.ticket.summary}`),
    criteriaBlock(context.acceptanceCriteria, texts),
    block("Test yaklaşımı", context.testApproach),
    block(text(texts, "ortak.baslik.gorev"), text(texts, "testDesigner.gorev")),
  ].join("\n\n");
}

/** Criteria (1-based) that no scenario claims. */
export function uncoveredCriteria(
  design: TestDesignOutput,
  criteriaCount: number,
): number[] {
  const covered = new Set(design.scenarios.map((s) => s.criterionIndex));
  const out: number[] = [];
  for (let i = 1; i <= criteriaCount; i++) if (!covered.has(i)) out.push(i);
  return out;
}

export function validateTestDesign(
  value: unknown,
  context: TestDesignContext,
  texts: PromptTexts = DEFAULT_PROMPT_TEXTS,
): Validation<TestDesignOutput> {
  const parsed = TestDesignOutput.safeParse(value);
  if (!parsed.success) return { ok: false, deficiencies: schemaDeficiencies(parsed.error.issues, texts) };

  const max = context.acceptanceCriteria.length;
  const deficiencies: Deficiency[] = [];
  for (const scenario of parsed.data.scenarios) {
    if (scenario.criterionIndex > max) {
      deficiencies.push({
        code: "criterion_out_of_range",
        message: text(texts, "eksik.kriterSirasi", {
          n: String(scenario.criterionIndex),
          max: String(max),
        }),
      });
    }
  }
  for (const index of uncoveredCriteria(parsed.data, max)) {
    deficiencies.push({
      code: "criterion_uncovered",
      message: text(texts, "eksik.kriterKapsamsiz", { n: String(index) }),
    });
  }
  if (!parsed.data.scenarios.some((s) => s.negative)) {
    deficiencies.push({ code: "no_negative", message: text(texts, "eksik.olumsuzSenaryoYok") });
  }
  return deficiencies.length === 0 ? { ok: true, value: parsed.data } : { ok: false, deficiencies };
}

export interface TestDesignArgs {
  llm: LlmPort;
  context: TestDesignContext;
  variantId: string;
  dataClass: DataClass;
  texts?: PromptTexts;
}

export function runTestDesigner(args: TestDesignArgs): Promise<RoleResult<TestDesignOutput>> {
  const texts = args.texts ?? DEFAULT_PROMPT_TEXTS;
  return runRole<TestDesignOutput>({
    llm: args.llm,
    role: "test_designer",
    variantId: args.variantId,
    dataClass: args.dataClass,
    schemaName: "TestDesignOutput",
    schema: TestDesignOutput,
    prompt: buildTestDesignPrompt(args.context, texts),
    check: (value) => validateTestDesign(value, args.context, texts),
    texts,
  });
}

// ── test reviewer ───────────────────────────────────────────────────────────

export interface TestReviewContext {
  acceptanceCriteria: string[];
  design: TestDesignOutput;
}

export function buildTestReviewPrompt(
  context: TestReviewContext,
  texts: PromptTexts = DEFAULT_PROMPT_TEXTS,
): string {
  const scenarios = context.design.scenarios.map(
    (s) =>
      `${s.title} · kriter ${s.criterionIndex} · ${s.kind}${s.negative ? " · olumsuz" : ""}\n` +
      `  Diyelim ki ${s.given.join(" / ")}\n  Eğer ${s.when.join(" / ")}\n  O zaman ${s.then.join(" / ")}`,
  );
  return [
    text(texts, "testReviewer.sistem"),
    rulesBlock("testReviewer", texts),
    criteriaBlock(context.acceptanceCriteria, texts),
    block(`Senaryolar — ${context.design.feature}`, bullets(scenarios, text(texts, "ortak.baglamBos"))),
    block(text(texts, "ortak.baslik.gorev"), text(texts, "testReviewer.gorev")),
  ].join("\n\n");
}

/**
 * The reviewer's own coverage claim is recomputed from the scenarios: a "4
 * eyes" check that agrees with a wrong first pair of eyes is not a check.
 */
export function validateTestReview(
  value: unknown,
  context: TestReviewContext,
  texts: PromptTexts = DEFAULT_PROMPT_TEXTS,
): Validation<TestReviewOutput> {
  const parsed = TestReviewOutput.safeParse(value);
  if (!parsed.success) return { ok: false, deficiencies: schemaDeficiencies(parsed.error.issues, texts) };

  const actual = uncoveredCriteria(context.design, context.acceptanceCriteria.length);
  const reported = new Set(parsed.data.uncoveredCriteria);
  const deficiencies: Deficiency[] = [];

  const missed = actual.filter((i) => !reported.has(i));
  if (missed.length > 0) {
    deficiencies.push({
      code: "coverage_report_wrong",
      message: text(texts, "eksik.kapsamRaporuYanlis", { liste: missed.join(", ") }),
    });
  }
  const invented = [...reported].filter((i) => !actual.includes(i));
  if (invented.length > 0) {
    deficiencies.push({
      code: "coverage_report_extra",
      message: text(texts, "eksik.kapsamRaporuFazla", { liste: invented.join(", ") }),
    });
  }
  if (parsed.data.uncoveredCriteria.length > 0 && parsed.data.approved) {
    deficiencies.push({ code: "approval_contradiction", message: text(texts, "eksik.kapsamCelismesi") });
  }
  return deficiencies.length === 0 ? { ok: true, value: parsed.data } : { ok: false, deficiencies };
}

export interface TestReviewArgs {
  llm: LlmPort;
  context: TestReviewContext;
  variantId: string;
  dataClass: DataClass;
  texts?: PromptTexts;
}

export function runTestReviewer(args: TestReviewArgs): Promise<RoleResult<TestReviewOutput>> {
  const texts = args.texts ?? DEFAULT_PROMPT_TEXTS;
  return runRole<TestReviewOutput>({
    llm: args.llm,
    role: "test_reviewer",
    variantId: args.variantId,
    dataClass: args.dataClass,
    schemaName: "TestReviewOutput",
    schema: TestReviewOutput,
    prompt: buildTestReviewPrompt(args.context, texts),
    check: (value) => validateTestReview(value, args.context, texts),
    texts,
  });
}

export function toTestReviewResult(output: TestReviewOutput): ReviewActivityResult {
  return {
    approved: output.approved,
    findings: output.findings.map((f) => {
      const where = f.scenarioTitle ?? (f.criterionIndex ? `kriter ${f.criterionIndex}` : "-");
      return `[${f.severity}] ${where} — ${f.problem}`;
    }),
  };
}
