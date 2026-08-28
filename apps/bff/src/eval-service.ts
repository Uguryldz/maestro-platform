import { z } from "zod";
import type { ResolvedDeps } from "./deps.js";
import type {
  EvalRunRecord,
  EvalRunResult,
  EvalWriter,
  GoldenTicket,
} from "./read-studio.js";
import { badRequest, conflict, notFound } from "./errors.js";
import { unwired } from "./routes/unwired.js";

/**
 * Golden-ticket evaluation (M38/M43) and the M78 justified-pass gate.
 *
 * The one rule this file exists to enforce: a candidate variant version that
 * REGRESSED against its baseline on any golden ticket may only be shipped with
 * an explicit, recorded justification. A silent pass is refused — the entire
 * point of the gate is that a regression is a decision a human takes on the
 * record, not one the platform makes by rendering a green page.
 *
 * `blocked` needs no justification: refusing a regression is the safe default
 * and requires no defence. `shipped` on a run WITH a regression is the case
 * that does — that is the "justified pass" M78 names.
 */

export interface EvalView {
  goldenTickets: readonly GoldenTicket[];
  lastRun: EvalRunRecord | null;
}

/** A regression = the candidate scored strictly worse than the baseline. */
export function isRegression(result: EvalRunResult): boolean {
  return (
    result.baselineScore !== null &&
    result.candidateScore !== null &&
    result.candidateScore < result.baselineScore
  );
}

export function hasRegression(run: EvalRunRecord): boolean {
  return run.results.some(isRegression);
}

/** The eval store, or a 503 by name when this deployment wired none. */
function evalOf(deps: ResolvedDeps): EvalWriter {
  const store = deps.studio.eval;
  if (store === undefined) unwired("eval");
  return store;
}

export async function readEval(deps: ResolvedDeps): Promise<EvalView> {
  const store = evalOf(deps);
  const [goldenTickets, lastRun] = await Promise.all([store.pool(), store.lastRun()]);
  return { goldenTickets, lastRun };
}

export const EvalDecisionBody = z.object({
  runId: z.string().trim().min(1).max(128),
  status: z.enum(["shipped", "blocked"]),
  /** Required only for shipping a regression; trimmed and bounded when present. */
  justification: z.string().trim().max(2_000).default(""),
});

export async function recordEvalDecision(
  deps: ResolvedDeps,
  input: { body: unknown; actor: string },
): Promise<EvalRunRecord> {
  const store = evalOf(deps);
  const parsed = EvalDecisionBody.safeParse(input.body);
  if (!parsed.success) throw badRequest("invalid_eval_decision");

  // Re-read the run under decision so the regression check runs against what the
  // store actually holds, never against a client's claim about it. A client that
  // said "no regression, ship it" over a run that did regress must not get past
  // this — the fact comes from the recorded scores.
  const run = await store.run(parsed.data.runId);
  if (run === null) throw notFound("unknown_eval_run");

  if (parsed.data.status === "shipped" && hasRegression(run) && parsed.data.justification === "") {
    // The justified-pass gate: a regression ships only WITH a written reason.
    throw conflict("eval_regression_needs_justification", {
      runId: parsed.data.runId,
      regressions: run.results.filter(isRegression).map((result) => result.goldenId),
    });
  }

  const at = deps.clock.now().toISOString();
  const updated = await store.recordDecision({
    runId: parsed.data.runId,
    status: parsed.data.status,
    // Only carry a justification when it means something: a `blocked` decision
    // or a clean pass records no defence it never needed.
    justification:
      parsed.data.status === "shipped" && hasRegression(run) ? parsed.data.justification : "",
    actor: input.actor,
    at,
  });
  if (updated === null) throw notFound("unknown_eval_run");

  await deps.audit.append({
    actor: input.actor,
    // INTERFACE REQUEST: `AuditAction` (frozen) has no `EVAL_DECISION`.
    // `PARAM_CHANGED` is the closest true statement — a recorded, audited
    // configuration decision from Studio — and the `eval:` subject prefix keeps
    // "who shipped a regression, and why" findable.
    action: "PARAM_CHANGED",
    subject: `eval:${parsed.data.runId}`,
    at,
    meta: {
      kind: "eval_decision",
      status: parsed.data.status,
      variantId: updated.variantId,
      candidateVersion: updated.candidateVersion,
      regressed: hasRegression(updated),
      // The justification is recorded on the trail precisely BECAUSE it is the
      // defence for shipping a regression — an auditor reads it here.
      justification: updated.decision.justification,
    },
  });
  return updated;
}
