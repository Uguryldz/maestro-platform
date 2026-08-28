import { condition } from "@temporalio/workflow";
import type { StepId, TicketKey } from "@maestro/contracts";
import type { EngineeringResult, MaestroActivities } from "./activities.js";
import { MAX_GATE_REJECTIONS, type Inbox, type RunState } from "./run-state.js";

/**
 * Steps 6a-10: build, scan, review, design tests, review those, run them.
 *
 * The loop is bounded (M54) and every exit is explicit — it either reaches
 * green tests, or it names the reason a human must take over. It never returns
 * "done" on anything less than a clean pass: a blocked scan and a red test run
 * both go back to 6a rather than forward, which is the fail-closed property the
 * whole step exists for (M27).
 */

/** What the loop decided: carry on to the PR, or stop and hand over. */
export type EngineeringOutcome =
  | { readonly kind: "ready"; readonly attempts: number }
  | { readonly kind: "handover"; readonly reason: string };

export interface EngineeringLoopDeps {
  /** The ordinary proxy — short activities with a small retry budget. */
  readonly acts: MaestroActivities;
  /** The patient proxy — an agent turn may legitimately run for hours. */
  readonly longActs: MaestroActivities;
  /** Announce a step transition (and let the kill switch stop the run). */
  readonly goto: (next: StepId, note: string) => Promise<void>;
  /** Open a human gate and wait for a real decision. */
  readonly gate: (at: StepId) => Promise<{ decision: "approve" | "reject"; reason?: string }>;
}

export async function runEngineeringLoop(
  deps: EngineeringLoopDeps,
  state: RunState,
  inbox: Inbox,
  ticket: TicketKey,
  required: readonly StepId[],
): Promise<EngineeringOutcome> {
  const { acts, longActs, goto, gate } = deps;
  let attempt = 0;

  for (;;) {
    attempt += 1;
    if (attempt > MAX_GATE_REJECTIONS) {
      return { kind: "handover", reason: `${MAX_GATE_REJECTIONS} tur ilerleme yok (M54)` };
    }

    await goto("6a", `geliştirme turu ${attempt}`);
    // Findings from the previous lap become this lap's task, then are cleared:
    // carrying them twice would ask the agent to fix what it just fixed.
    const task = inbox.changesRequested ?? "analizdeki kabul kriterlerini karşıla";
    inbox.changesRequested = undefined;
    const eng: EngineeringResult = await longActs.runEngineering(ticket, state.resumeToken, task, attempt);
    state.resumeToken = eng.resumeToken;
    if (!eng.ok) {
      if (eng.handoverReason !== undefined) return { kind: "handover", reason: eng.handoverReason };
      continue;
    }

    // 6b · scans — fail-closed: anything but a clean pass goes back (M27).
    await goto("6b", "güvenlik taraması");
    const scans = await acts.runScans(ticket, attempt);
    if (scans.some((s) => s.outcome !== "pass")) {
      await acts.journal(ticket, "scan", "tarama bloke etti", "bulgularla 6a'ya dönüldü");
      continue;
    }

    // 6c · dev-reviewer
    await goto("6c", "diff incelemesi");
    const review = await acts.reviewDiff(ticket, attempt);
    if (!review.approved) {
      inbox.changesRequested = review.findings.join("\n");
      continue;
    }

    // 7-8 · test design and its four-eyes review
    await goto("7", "test senaryoları");
    await acts.designTests(ticket, attempt);
    await goto("8", "senaryo denetimi");
    const testReview = await acts.reviewTests(ticket, attempt);
    if (!testReview.approved) {
      inbox.changesRequested = testReview.findings.join("\n");
      continue;
    }

    // 9 · QA scenario gate (only in the tiers that require it)
    if (required.includes("9")) {
      await goto("9", "QA senaryo onayı");
      const qa = await gate("9");
      if (qa.decision === "reject") {
        inbox.changesRequested = qa.reason ?? "";
        continue;
      }
    }

    // 10 · the tests actually run. The verdict comes from exit codes, never
    // from a summary (see `impl/engineering.ts`).
    await goto("10", "testler koşuyor");
    const run = await acts.runTests(ticket, attempt);
    if (!run.passed) {
      await acts.journal(ticket, "test_run", "testler kırmızı", `${run.failed}/${run.total}`);
      continue;
    }
    return { kind: "ready", attempts: attempt };
  }
}

/**
 * Step 10b: wait for build validation, and fix the branch until it is green.
 *
 * Two rules this loop exists to enforce. A result whose origin is not this
 * run's repository is not evidence and is refused (M106) — the gate keeps
 * waiting rather than treating a neighbouring pipeline's success as its own.
 * And the queue is never cleared: a fix can take hours, ADO reports a finished
 * build exactly once, so a green result that lands mid-fix has to survive until
 * the loop comes back to look at it.
 */
export async function awaitGreenBuild(
  deps: Pick<EngineeringLoopDeps, "acts" | "longActs">,
  state: RunState,
  inbox: Inbox,
  ticket: TicketKey,
  /** The last engineering round, so each CI fix gets a round of its own. */
  afterAttempt: number,
): Promise<EngineeringOutcome> {
  const { acts, longActs } = deps;
  // M54: the same red build three times over is not progress either.
  let fixes = 0;

  for (;;) {
    await condition(() => inbox.ciResults.length > 0);
    const signal = inbox.ciResults.shift();
    if (signal === undefined) continue;
    if (!(await acts.verifyCiOrigin(ticket, signal))) {
      await acts.journal(ticket, "ci", "yabancı CI sinyali reddedildi", signal.adoRepo ?? "?");
      continue;
    }
    if (signal.status === "succeeded") return { kind: "ready", attempts: afterAttempt + fixes };

    fixes += 1;
    if (fixes > MAX_GATE_REJECTIONS) {
      return { kind: "handover", reason: `${fixes - 1} kez CI düzeltilemedi (M54)` };
    }
    await acts.journal(ticket, "ci", "CI kırmızı", "6a'ya dönülüyor");
    const fix: EngineeringResult = await longActs.runEngineering(
      ticket,
      state.resumeToken,
      "CI hatasını düzelt",
      afterAttempt + fixes,
    );
    state.resumeToken = fix.resumeToken;
    if (!fix.ok && fix.handoverReason !== undefined) {
      return { kind: "handover", reason: fix.handoverReason };
    }
  }
}
