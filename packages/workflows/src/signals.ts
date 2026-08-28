import { defineQuery, defineSignal } from "@temporalio/workflow";
import type {
  CiResultSignal,
  ClarificationAnswerSignal,
  GateDecision,
  KillSwitchSignal,
  WorkMode,
  WorkflowRunState,
} from "@maestro/contracts";

/**
 * Everything the outside world can say to a running ticket, and the one thing
 * it can ask. Signals are the ONLY way in: the workflow never polls, so a gate
 * that waits sixteen days costs nothing and survives a redeploy (M30/M61).
 */

/** A human decided at a gate — `/approve` or `/reject <reason>` (M51). */
export const gateDecisionSignal = defineSignal<[GateDecision]>("gateDecision");

/** The reporter answered the clarification question (step 2b, M98). */
export const clarificationAnsweredSignal =
  defineSignal<[ClarificationAnswerSignal]>("clarificationAnswered");

/** ADO branch policy finished a build validation (step 10b, M12/M106). */
export const ciResultSignal = defineSignal<[CiResultSignal]>("ciResult");

/** A PR thread asked for changes — back to engineering, same session (12b). */
export const prChangesRequestedSignal =
  defineSignal<[{ threadId: number; text: string; at: string }]>("prChangesRequested");

/** Work mode changed mid-flight via `/mode-change` (M46). */
export const modeChangeSignal = defineSignal<[{ mode: WorkMode; actor: string }]>("modeChange");

/** Two-level kill switch (M58). `all` stops work; gates keep waiting. */
export const killSwitchSignal = defineSignal<[KillSwitchSignal]>("killSwitch");

/** Studio and the Jira `/status` command read the run through this. */
export const runStateQuery = defineQuery<WorkflowRunState>("runState");
