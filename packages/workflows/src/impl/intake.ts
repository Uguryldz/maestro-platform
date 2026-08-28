import {
  AppId,
  type DataClass,
  type MatchResult,
  NonEmpty,
  type RoutingRule,
  type TicketKey,
  type TicketSnapshot,
  type WorkMode,
} from "@maestro/contracts";
import { ApplicationFailure } from "@temporalio/common";
import { z } from "zod";
import type { IntakeResult } from "../activities.js";
import type { ActivityDeps } from "./deps.js";
import { guardModelCall, resolveOutcome } from "./outcome.js";
import { audit, record } from "./record.js";

/**
 * Steps 0-2b: work mode, ticket→application matching (M99) and the
 * completeness check with its clarification question (M98).
 */

/** Fail-closed: an incomplete ticket that carries no question is unusable. */
export const IntakeVerdict = z
  .object({ complete: z.boolean(), question: NonEmpty.max(1000).optional() })
  .superRefine((v, ctx) => {
    if (!v.complete && v.question === undefined) {
      ctx.addIssue({ code: "custom", path: ["question"], message: "incomplete intake needs a question" });
    }
  });

export const AppSuggestion = z.object({
  appId: AppId,
  confidence: z.number().min(0).max(1),
});

/** M99 tier ②: below this the suggestion is not offered at all. */
export const MIN_SUGGESTION_CONFIDENCE = 0.5;

export async function resolveWorkMode(
  deps: ActivityDeps,
  ticket: TicketKey,
): Promise<{ mode: WorkMode; dataClass: DataClass }> {
  const run = await deps.runs.get(ticket);
  await audit(deps, run, {
    action: "RUN_STARTED",
    meta: { mode: run.mode, dataClass: run.dataClass },
    key: "start",
  });
  return { mode: run.mode, dataClass: run.dataClass };
}

/**
 * Does this rule apply to this ticket? Conditions are the frozen three (M99
 * tier ①); an unknown shape cannot occur because the contract is a
 * discriminated union, and the exhaustive switch keeps it that way.
 */
export function ruleApplies(rule: RoutingRule, ticket: TicketSnapshot): boolean {
  if (rule.projectKey !== "*" && rule.projectKey !== ticket.projectKey) return false;
  switch (rule.condition.type) {
    case "always":
      return true;
    case "component":
      return ticket.components.includes(rule.condition.component);
    case "label":
      return ticket.labels.includes(rule.condition.label);
  }
}

/**
 * Highest `priority` wins; equal priorities are broken by `ruleId` so two
 * rules that tie always resolve the same way — a matcher whose answer depends
 * on row order gives a different application on a replay.
 */
export function pickRule(rules: readonly RoutingRule[], ticket: TicketSnapshot): RoutingRule | null {
  const applicable = rules.filter((rule) => ruleApplies(rule, ticket) && rule.effect.appId !== undefined);
  const ordered = [...applicable].sort(
    (a, b) => b.priority - a.priority || a.ruleId.localeCompare(b.ruleId),
  );
  return ordered[0] ?? null;
}

/**
 * M99, three tiers and no silent default: a rule, else an AI suggestion the
 * human confirms at the analysis gate, else `null` — which stops the flow and
 * puts the ticket in the "awaiting assignment" queue (M14 fail-closed).
 */
export async function matchApplication(
  deps: ActivityDeps,
  ticket: TicketKey,
): Promise<MatchResult | null> {
  const run = await deps.runs.get(ticket);
  const snapshot = await deps.work.getTicket(ticket);

  const rule = pickRule(await deps.params.routingRules(ticket), snapshot);
  if (rule?.effect.appId !== undefined) {
    const matched: MatchResult = { via: "rule", ruleId: rule.ruleId, appId: rule.effect.appId };
    await audit(deps, run, { action: "ASSIGN_APP", meta: matched, key: "match" });
    return matched;
  }

  // Routed through the auth guard: a driver-thrown `LlmAuthError` must leave
  // a journal line and stay bounded instead of retrying in silence.
  const outcome = await guardModelCall(deps, run, "match", () =>
    deps.llm.generateObject(
      {
        role: "intake",
        variantId: run.variantId,
        dataClass: run.dataClass,
        schemaName: "app-suggestion",
        input: { summary: snapshot.summary, description: snapshot.description, components: snapshot.components },
      },
      AppSuggestion,
    ),
  );
  const resolved = await resolveOutcome(deps, run, "match", outcome);
  if (resolved.status === "degraded") return null;
  if (resolved.value.confidence < MIN_SUGGESTION_CONFIDENCE) return null;

  const suggested: MatchResult = {
    via: "ai_suggestion",
    appId: resolved.value.appId,
    confidence: resolved.value.confidence,
    // The human confirms it when they approve the analysis (M99 tier ②).
    validatedAtGate: false,
  };
  await audit(deps, run, { action: "ASSIGN_APP", meta: suggested, key: "match" });
  return suggested;
}

/**
 * Step 2. A degraded gateway does not fail the ticket: the run drops to
 * ai-assist (M97) and the reporter is asked to complete it by hand, which is
 * exactly what step 2b already knows how to wait for.
 */
export async function runIntake(deps: ActivityDeps, ticket: TicketKey): Promise<IntakeResult> {
  const run = await deps.runs.get(ticket);
  const snapshot = await deps.work.getTicket(ticket);
  const outcome = await guardModelCall(deps, run, "intake", () =>
    deps.llm.generateObject(
      {
        role: "intake",
        variantId: run.variantId,
        dataClass: run.dataClass,
        schemaName: "intake-verdict",
        input: { summary: snapshot.summary, description: snapshot.description, issueType: snapshot.issueType },
      },
      IntakeVerdict,
    ),
  );
  const resolved = await resolveOutcome(deps, run, "intake", outcome);
  if (resolved.status === "degraded") {
    return { complete: false, question: deps.translate(run.locale, "intake.manual_completion") };
  }

  const verdict = resolved.value;
  await record(deps, run, {
    kind: "intake",
    actor: "ai",
    title: verdict.complete ? "ticket eksiksiz" : "ticket eksik",
    detail: verdict.question ?? "",
    key: "intake",
  });
  return verdict.complete ? { complete: true } : { complete: false, question: verdict.question ?? "" };
}

/** Step 2b. The question is a Jira comment; the answer arrives as a signal. */
export async function askClarification(
  deps: ActivityDeps,
  ticket: TicketKey,
  question: string,
): Promise<void> {
  const run = await deps.runs.get(ticket);
  const text = question.trim();
  if (text === "") {
    // A blank question would wait forever with nothing on the ticket to answer.
    throw ApplicationFailure.create({
      message: "refusing to open the clarification wait with an empty question",
      type: "EmptyClarification",
      nonRetryable: true,
    });
  }
  await deps.idempotency.once(`${run.runId}:clarify`, () =>
    deps.work.addComment(ticket, deps.translate(run.locale, "jira.clarification", { question: text })),
  );
  await record(deps, run, { kind: "clarification", title: "soru soruldu", detail: text, key: "ask" });
  await audit(deps, run, { action: "CLARIFICATION_ASKED", key: "ask" });
  await deps.idempotency.once(`${run.runId}:clarify:label`, () =>
    deps.work.setLabels(ticket, ["maestro-bekliyor"]),
  );
}
