import { APPROVAL_GATE_STEPS, type WorkflowRunState } from "@maestro/contracts";

/** Is this run parked on a human approval gate right now? */
export function isApprovalGate(run: Pick<WorkflowRunState, "status" | "step">): boolean {
  return run.status === "gate" && (APPROVAL_GATE_STEPS as readonly string[]).includes(run.step);
}

/** Step 2b is a clarification WAIT, not an approval — different control set. */
export function isClarificationWait(run: Pick<WorkflowRunState, "status" | "step">): boolean {
  return run.status === "gate" && run.step === "2b";
}
