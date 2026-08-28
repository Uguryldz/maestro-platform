import { condition, ApplicationFailure } from "@temporalio/workflow";
import type { GateDecision, StepId, TicketKey } from "@maestro/contracts";
import type { MaestroActivities } from "./activities.js";
import { canCloseGate, GATE_OWNER } from "./gates.js";
import type { Inbox, RunState } from "./run-state.js";

/**
 * The three things that interrupt a step sequence: a human gate, the kill
 * switch, and a mode change nobody can honour.
 *
 * They are here rather than inline in the workflow because each one is a loop
 * with its own rules, and reading the delivery flow should not mean reading
 * them. Everything takes the activity proxy as an argument, so nothing here
 * decides how patient a call is — that stays with the caller.
 */

const HOUR = 60 * 60 * 1000;

/** Milliseconds a gate waits before it emits one reminder tick (M88). */
export const GATE_REMINDER_INTERVAL_MS = HOUR;

/**
 * Wait at a human gate until somebody decides. Reminders fire on the
 * parameterised ladder; they never decide anything themselves (M88).
 * Returns the decision — approve continues, reject sends the flow back.
 */
export async function awaitGate(
  acts: MaestroActivities,
  state: RunState,
  inbox: Inbox,
  ticket: TicketKey,
  at: StepId,
): Promise<GateDecision> {
  const owner = GATE_OWNER[at as keyof typeof GATE_OWNER] ?? "tech-leads";
  state.status = "gate";
  // The queue is NOT cleared: a decision already waiting was sent by a human
  // looking at this ticket, and whether it belongs to this gate is settled by
  // `canCloseGate`'s `wrong_step` check, not by whether it arrived early.
  // The group the gate is really open against — the directory's name for the
  // role, which is what an approver's claim will carry.
  const openedAgainst = await acts.openGate(ticket, at, owner);

  let waited = 0;
  for (;;) {
    await condition(() => inbox.decisions.length > 0, GATE_REMINDER_INTERVAL_MS);
    // Drain everything queued before waiting again: two decisions delivered in
    // one batch must both be processed, or the run parks holding a signal it
    // never looks at.
    for (let closed = inbox.decisions.shift(); closed !== undefined; closed = inbox.decisions.shift()) {
      let verdict = canCloseGate(closed, at, state.approvers, false, openedAgainst);
      // A master admin may sign both sides of the four-eyes rule so a
      // single-admin install is not deadlocked. Only re-check on an actual
      // sod_violation (a directory lookup, so keep it off the happy path), and
      // only the cross-gate rule is waived — wrong_step/wrong_group/not_verified
      // still stand.
      if (!verdict.ok && verdict.reason === "sod_violation") {
        if (await acts.isMasterApprover(closed.actorUserId)) {
          verdict = canCloseGate(closed, at, state.approvers, true, openedAgainst);
        }
      }
      if (!verdict.ok) {
        // Refused, not ignored: the person is told why and the gate stays open.
        await acts.journal(ticket, "gate", "karar reddedildi", `${closed.actorUserId} · ${verdict.reason}`);
        continue;
      }
      const recorded = await acts.recordGateDecision(ticket, closed);
      if (!recorded.accepted) {
        // The directory disagreed with what the payload claimed. The gate stays
        // open and the person is told; the run does not die over it.
        await acts.journal(ticket, "gate", "karar reddedildi", recorded.reason);
        continue;
      }
      if (closed.decision === "approve") state.approvers.set(at, closed.actorUserId);
      state.status = "running";
      return closed;
    }
    waited += 1;
    await acts.escalateGate(ticket, at, waited);
  }
}

/**
 * The kill switch stops work between steps; it never abandons an open gate.
 *
 * Level ② (`all`) stops this run. Level ① (`intake_only`) pauses the INTAKE of
 * new work — a decision about tickets that have not started, so a run already
 * under way is not affected. That is a legitimate no-op, but a SILENT one is
 * not: the admin who pulled the lever is entitled to see, on this ticket, that
 * it kept going and why (M14/M58).
 */
export async function assertNotKilled(
  acts: MaestroActivities,
  state: RunState,
  ticket: TicketKey,
): Promise<void> {
  if (state.killed === "all") {
    state.status = "cancelled";
    await acts.journal(ticket, "other", "kill-switch", "tüm işler durduruldu (M58)");
    throw ApplicationFailure.nonRetryable("kill switch: all", "KillSwitch");
  }
  if (state.killed !== "intake_only" || state.intakeOnlyNoted) return;

  state.intakeOnlyNoted = true;
  // Before the intake step there is no work yet, so the pause applies and this
  // run stops. Past it, the ticket is already in flight and continues.
  if (state.step === "0") {
    state.status = "cancelled";
    await acts.journal(
      ticket,
      "other",
      "kill-switch",
      "seviye ① — yeni iş alımı durduruldu, bu koşu başlamadan durdu (M58)",
    );
    throw ApplicationFailure.nonRetryable("kill switch: intake_only", "KillSwitch");
  }
  await acts.journal(
    ticket,
    "other",
    "kill-switch",
    "seviye ① (intake) — başlamış koşu etkilenmez, akış sürüyor (M58)",
  );
}

/**
 * Answer a `/mode-change` (M46).
 *
 * The mode is read once, before the first `await`, so an in-flight run cannot
 * be re-routed by it. The request is therefore REFUSED out loud rather than
 * accepted and forgotten: the BFF already answers 200, and a workflow that then
 * ignored the signal made `/ai-takeover` look implemented when it was not.
 */
export async function answerModeRequests(
  acts: MaestroActivities,
  state: RunState,
  inbox: Inbox,
  ticket: TicketKey,
): Promise<void> {
  while (inbox.modeRequests.length > 0) {
    const request = inbox.modeRequests.shift();
    if (request === undefined || request.mode === state.mode) continue;
    await acts.journal(
      ticket,
      "other",
      "mod değişikliği reddedildi",
      `${request.actor} · '${request.mode}' istendi; koşu '${state.mode}' modunda başladı ve mod koşu ortasında değiştirilemez (M46)`,
    );
  }
}
