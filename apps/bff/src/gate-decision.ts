import {
  APPROVAL_GATE_STEPS,
  GateDecision,
  type StepId,
  type TicketKey,
} from "@maestro/contracts";
import type { ResolvedDeps } from "./deps.js";
import { workflowIdFor } from "./gateway.js";
import { projectKeyOf } from "./jira-intake.js";
import { SIGNALS } from "./signal-names.js";

/**
 * The one place a gate is closed, shared by the Jira comment path (M51's
 * primary channel) and Studio's secondary one. Both go through the same
 * membership check, the same audit record and the same signal, so there is no
 * second, weaker way in — that asymmetry is what SoD (M32) actually rests on.
 */

export interface GateRequest {
  ticket: TicketKey;
  decision: "approve" | "reject";
  reason?: string;
  /** Audit actor, `user@corp`; also the identity four-eyes compares across gates. */
  actor: string;
  /** The id the work system knows the person by (Jira login / corporate account). */
  membershipId: string;
  source: "jira" | "studio";
  at: string;
}

export type GateFailure = "no_run" | "no_open_gate" | "not_member" | "not_delivered";

export type GateResult =
  | { ok: true; step: StepId; group: string; signatureSeq: number }
  | { ok: false; reason: GateFailure; step?: StepId; group?: string };

function isApprovalGate(step: StepId): boolean {
  return (APPROVAL_GATE_STEPS as readonly StepId[]).includes(step);
}

export async function decideGate(deps: ResolvedDeps, request: GateRequest): Promise<GateResult> {
  const workflowId = workflowIdFor(request.ticket);
  const state = await deps.runs.queryRunState(workflowId);
  if (state === null) return { ok: false, reason: "no_run" };

  // A decision is only meaningful at an OPEN approval gate. The clarification
  // wait (2b) also reports `gate`, and it is not something to approve.
  if (state.status !== "gate" || !isApprovalGate(state.step)) {
    return { ok: false, reason: "no_open_gate", step: state.step };
  }

  const group = await deps.gates.ownerGroup(state.step, projectKeyOf(request.ticket));
  if (group === null) return { ok: false, reason: "no_open_gate", step: state.step };

  // M32/M35: group membership is the whole authority behind a gate decision,
  // and it is checked before anything is recorded or signalled. An unverifiable
  // membership throws out of the port — fail-closed, never "assume yes".
  const member = await deps.work.verifyMembership(request.membershipId, group);
  if (!member) return { ok: false, reason: "not_member", step: state.step, group };

  // Audit first, on purpose: `signatureSeq` IS the position in the hash chain
  // (M33), so a signature can be located in the trail by its number and cannot
  // be minted by a counter that lives somewhere the auditor cannot see. The
  // trail also refuses a non-human actor for these two actions, which is the
  // last line of defence behind M101's "no gate tool for the AI".
  const event = await deps.audit.append({
    actor: request.actor,
    action: request.decision === "approve" ? "GATE_APPROVE" : "GATE_REJECT",
    subject: request.ticket,
    at: request.at,
    meta: {
      step: state.step,
      group,
      source: request.source,
      ...(request.reason !== undefined ? { reason: request.reason } : {}),
    },
  });

  const decision = GateDecision.parse({
    step: state.step,
    decision: request.decision,
    actorUserId: request.actor,
    actorGroup: group,
    sodVerified: true,
    signatureSeq: event.seq,
    source: request.source,
    at: request.at,
    ...(request.reason !== undefined ? { reason: request.reason } : {}),
  });

  const delivered = await deps.runs.signal(workflowId, SIGNALS.gateDecision, decision);
  if (delivered === "no_run") {
    return { ok: false, reason: "not_delivered", step: state.step, group };
  }
  return { ok: true, step: state.step, group, signatureSeq: event.seq };
}
