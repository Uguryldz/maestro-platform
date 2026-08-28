import { NonEmpty, type TicketKey } from "@maestro/contracts";
import type { AgentTurnResult, SessionReport } from "@maestro/execution";
import { buildLivingSummary } from "@maestro/memory";
import { z } from "zod";
import type { EngineeringResult, ReviewResult, TestRunResult } from "../activities.js";
import type { ActivityDeps, RunContext } from "./deps.js";
import { guardModelCall, handOver, quotaWait, resolveOutcome } from "./outcome.js";
import { audit, record } from "./record.js";

/**
 * Steps 6a, 6c, 7, 8 and 10: the doing role and the roles that judge it.
 *
 * Every turn goes through `@maestro/execution`, which is where the M52
 * protected-path gate and the M54 strike counter live. This file's job is to
 * carry the resume token faithfully (M30) and to translate the turn's outcome
 * into the two facts the workflow acts on: did it work, and must a human take
 * over.
 */

export const ReviewVerdict = z.object({
  approved: z.boolean(),
  findings: z.array(NonEmpty.max(2000)).max(50).default([]),
});

export const TestDesign = z.object({ scenarios: z.number().int().nonnegative() });

export const TestRunDigest = z.object({
  total: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  coveragePct: z.number().min(0).max(100),
});

/** The context a NEW session opens with (M30); a resumed one gets the task only. */
async function turnContext(deps: ActivityDeps, run: RunContext, task: string) {
  const entries = await deps.memory.store.list(run.runId);
  return {
    ticketKey: run.ticket,
    runId: run.runId,
    task,
    journal: entries,
    livingSummary: entries.length === 0 ? null : buildLivingSummary(run.runId, entries),
    workspace: {
      path: run.workspacePath,
      present: run.workspacePresent,
      branch: run.branch,
      baseSha: null,
      dirtyFiles: [],
    },
    protectedPaths: run.protectedPaths,
    mcpServers: ["workspace", "jira", "ado"],
  };
}

/**
 * One agent turn, and the four ways it can end other than "done".
 *
 * `queued` is a retryable failure so Temporal parks the run until the quota
 * window opens (M55); `blocked` is permanent (M18); `degraded` and a strike
 * limit both hand the ticket over, which is a RESULT, not a failure — the
 * workflow decides what to do with it.
 */
async function finishTurn(
  deps: ActivityDeps,
  run: RunContext,
  outcome: AgentTurnResult,
  what: string,
): Promise<{ report: SessionReport; handoverReason?: string } | { handoverReason: string }> {
  switch (outcome.status) {
    case "queued":
      throw quotaWait(outcome.resumeAt, deps.now());
    case "blocked":
      // O4: the handover is real and fully recorded, so it must be REPORTED as
      // a handover. Throwing here instead closed the run as a failure, and the
      // ticket showed up in Studio as "başarısız" while it was in fact sitting
      // correctly in a human's queue. The compliance decision is on the record
      // either way; what changes is that the workflow can now act on it.
      await handOver(deps, run, `${what}: ${outcome.messageKey}`, `blocked:${what}`);
      return { handoverReason: `${what}: ${outcome.messageKey}` };
    case "degraded":
      await deps.runs.patch(run.ticket, { mode: "ai_assist" });
      return { handoverReason: `ai_assist (M97): ${outcome.messageKey}` };
    case "ok":
      return { report: outcome.report };
    case "failed": {
      // M52 is absolute: an illegal diff stops the flow on the FIRST offence,
      // it does not get three tries. A red build gets the strike ladder.
      const reason =
        outcome.reason === "protected_path"
          ? `korumalı yol ihlali (M52): ${outcome.report.protectedViolations.map((v) => v.path).join(", ")}`
          : outcome.handover.handover
            ? `${outcome.handover.count}/${outcome.handover.limit} tur ilerleme yok (M54)`
            : undefined;
      return reason === undefined ? { report: outcome.report } : { report: outcome.report, handoverReason: reason };
    }
  }
}

/** Step 6a / 12b / CI fix — always the SAME session when a token exists (M30). */
export async function runEngineering(
  deps: ActivityDeps,
  ticket: TicketKey,
  resumeToken: string | null,
  task: string,
  attempt = 1,
): Promise<EngineeringResult> {
  const run = await deps.runs.get(ticket);
  const outcome = await deps.execution.runTurn({
    context: await turnContext(deps, run, task),
    dataClass: run.dataClass,
    variantId: run.variantId,
    // The token the WORKFLOW holds wins: it is the only copy that survives a
    // redeploy, and the store's copy may be a retry's stale read.
    ...(resumeToken === null ? {} : { resumeToken }),
    verification: run.verification,
  });
  const finished = await finishTurn(deps, run, outcome, "engineering");

  if (!("report" in finished)) {
    return { ok: false, resumeToken: resumeToken ?? "", changedFiles: 0, diffSummary: "", handoverReason: finished.handoverReason };
  }
  const { report } = finished;
  await deps.runs.patch(ticket, { resumeToken: report.resumeToken, workspacePresent: true });
  await record(deps, run, {
    kind: "engineering",
    actor: "ai",
    title: "geliştirme turu",
    detail: `${report.diff.files} dosya · +${report.diff.insertions} -${report.diff.deletions}`,
    key: `engineering:${attempt}:${report.at}`,
  });
  const ok = finished.handoverReason === undefined && report.protectedViolations.length === 0;
  return {
    ok,
    resumeToken: report.resumeToken,
    changedFiles: report.diff.files,
    diffSummary: `+${report.diff.insertions} -${report.diff.deletions}`,
    ...(finished.handoverReason === undefined ? {} : { handoverReason: finished.handoverReason }),
  };
}

/** Steps 6c and 8 — the AI reviews (a degraded gateway means "not approved"). */
async function review(
  deps: ActivityDeps,
  ticket: TicketKey,
  role: "dev_reviewer" | "test_reviewer",
  schemaName: string,
  attempt: number,
): Promise<ReviewResult> {
  const run = await deps.runs.get(ticket);
  const outcome = await guardModelCall(deps, run, role, () =>
    deps.llm.generateObject(
      { role, variantId: run.variantId, dataClass: run.dataClass, schemaName, input: { ticket } },
      ReviewVerdict,
    ),
  );
  const resolved = await resolveOutcome(deps, run, role, outcome);
  if (resolved.status === "degraded") {
    return { approved: false, findings: [`ai_assist (M97): ${resolved.messageKey}`] };
  }
  await record(deps, run, {
    kind: role === "dev_reviewer" ? "review" : "test_review",
    actor: "ai",
    title: resolved.value.approved ? "inceleme onaylandı" : "inceleme bulguları",
    detail: resolved.value.findings.join("\n"),
    // Keyed on the ROUND, not on the verdict: two rounds that both came back
    // with the same two findings are two events, and the journal must show both.
    key: `${role}:${attempt}`,
  });
  return { approved: resolved.value.approved, findings: [...resolved.value.findings] };
}

export const reviewDiff = (
  deps: ActivityDeps,
  ticket: TicketKey,
  attempt = 1,
): Promise<ReviewResult> => review(deps, ticket, "dev_reviewer", "diff-review", attempt);

export const reviewTests = (
  deps: ActivityDeps,
  ticket: TicketKey,
  attempt = 1,
): Promise<ReviewResult> => review(deps, ticket, "test_reviewer", "test-review", attempt);

export async function designTests(
  deps: ActivityDeps,
  ticket: TicketKey,
  attempt = 1,
): Promise<{ scenarios: number }> {
  const run = await deps.runs.get(ticket);
  const outcome = await guardModelCall(deps, run, "test-design", () =>
    deps.llm.generateObject(
      {
        role: "test_designer",
        variantId: run.variantId,
        dataClass: run.dataClass,
        schemaName: "test-design",
        input: { ticket },
      },
      TestDesign,
    ),
  );
  const resolved = await resolveOutcome(deps, run, "test-design", outcome);
  const scenarios = resolved.status === "degraded" ? 0 : resolved.value.scenarios;
  await record(deps, run, {
    kind: "test_design",
    actor: "ai",
    title: "test senaryoları",
    detail: `${scenarios} senaryo`,
    key: `test-design:${attempt}`,
  });
  return { scenarios };
}

/**
 * Step 10. The verdict comes from the EXIT CODES, never from the model: the
 * model is asked only to count what it sees, and a summariser that says
 * "passed" over a red build must not be able to open the PR.
 */
export async function runTests(
  deps: ActivityDeps,
  ticket: TicketKey,
  attempt = 1,
): Promise<TestRunResult> {
  const run = await deps.runs.get(ticket);
  const outcome = await deps.execution.runTurn({
    context: await turnContext(deps, run, deps.translate(run.locale, "agent.test_task", { ticket })),
    dataClass: run.dataClass,
    variantId: run.variantId,
    ...(run.resumeToken === null ? {} : { resumeToken: run.resumeToken }),
    verification: run.verification,
  });
  const finished = await finishTurn(deps, run, outcome, "test-run");
  if (!("report" in finished)) return { passed: false, total: 0, failed: 0, coveragePct: 0 };

  const { report } = finished;
  const red = report.commands.filter((c) => c.exitCode !== 0);
  const digest = await guardModelCall(deps, run, "test-digest", () =>
    deps.llm.generateObject(
      {
        role: "test_engineer",
        variantId: run.variantId,
        dataClass: run.dataClass,
        schemaName: "test-run",
        input: { output: report.commands.map((c) => `${c.name}: ${c.stdoutTail}`).join("\n") },
      },
      TestRunDigest,
    ),
  );
  const resolved = await resolveOutcome(deps, run, "test-digest", digest);
  const counted =
    resolved.status === "degraded"
      ? { total: report.commands.length, failed: red.length, coveragePct: 0 }
      : resolved.value;

  const passed = red.length === 0 && finished.handoverReason === undefined;
  await audit(deps, run, {
    action: "TEST_RUN_COMPLETE",
    meta: { passed, failedCommands: red.length },
    key: `tests:${attempt}:${report.at}`,
  });
  await record(deps, run, {
    kind: "test_run",
    title: passed ? "testler yeşil" : "testler kırmızı",
    detail: `${counted.failed}/${counted.total} · kapsam %${counted.coveragePct}`,
    key: `tests:${attempt}:${report.at}`,
  });
  return { passed, total: counted.total, failed: counted.failed, coveragePct: counted.coveragePct };
}
