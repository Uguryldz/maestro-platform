import type { CommandEnvelope, CommandName, TicketKey, WorkMode } from "@maestro/contracts";
import { toActorOrNull } from "./actor.js";
import type { ResolvedDeps } from "./deps.js";
import { decideGate, type GateResult } from "./gate-decision.js";
import { workflowIdFor } from "./gateway.js";
import { classifyingFields, projectKeyOf, runIntake, type IntakeOutcome } from "./jira-intake.js";
import { BFF_MESSAGE_KEYS, stepTitleKey } from "./messages.js";
import { SIGNALS } from "./signal-names.js";

/**
 * Jira comment commands (M46/M105). Three rules shape everything below:
 *
 *  · the grammar is the driver's business — by the time a `CommandEnvelope`
 *    reaches here, "/approve etmiyorum" has already been refused as a command
 *    with trailing text, and an edited comment has already been discarded;
 *  · an unbound or paused project is dropped in SILENCE (M102). This is the one
 *    place where not answering is the correct behaviour: the single global
 *    webhook sees every project in the instance, and a reply — even a refusal —
 *    would tell the author that Maestro is watching a project it was never
 *    bound to. `/status` would hand them the run's step on top of that;
 *  · otherwise nothing fails quietly. Every refusal on a BOUND project is
 *    written back to the ticket with a catalog key, because a comment that
 *    vanishes is indistinguishable from a platform that is down (M14).
 */

export type CommandOutcome =
  | { accepted: true; command: CommandName; workflowId?: string }
  | { accepted: false; command: CommandName; reason: string }
  /** Dropped before the command was interpreted; carries no command name to leak. */
  | { accepted: false; reason: "unbound" | "kill_switch" };

async function reply(
  deps: ResolvedDeps,
  ticket: TicketKey,
  key: string,
  params: Record<string, string> = {},
): Promise<void> {
  await deps.work.addComment(ticket, deps.messages.t(deps.config.locale, key, params));
}

/**
 * A reply whose catalog key may not have shipped yet (see
 * `REQUESTED_MESSAGE_KEYS`). Used only on the invalid-actor path, where the
 * whole point is to answer 202 instead of a 5xx that Jira would retry forever —
 * failing to render the explanation must not resurrect the very error the
 * explanation exists to avoid.
 */
async function replyIfRenderable(
  deps: ResolvedDeps,
  ticket: TicketKey,
  key: string,
  params: Record<string, string> = {},
): Promise<void> {
  let text: string;
  try {
    text = deps.messages.t(deps.config.locale, key, params);
  } catch {
    return;
  }
  await deps.work.addComment(ticket, text);
}

/** Gate decisions survive the kill switch; everything else waits (M58). */
function isGateDecision(name: CommandName): boolean {
  return name === "approve" || name === "reject";
}

export async function handleCommand(
  deps: ResolvedDeps,
  envelope: CommandEnvelope,
): Promise<CommandOutcome> {
  const { ticketKey: ticket, author, at, command } = envelope;

  // M102, before anything else and before any reply: a project Maestro was
  // never bound to, or one an admin paused, gets no answer at all. `runIntake`
  // has always done this; the command path used to skip it and answered on
  // tickets the platform had no business knowing about.
  const binding = await deps.bindings.resolve(projectKeyOf(ticket));
  if (binding === null || !binding.active) {
    deps.counters.droppedUnbound += 1;
    return { accepted: false, reason: "unbound" };
  }

  // M58: `all` stops the platform, but an open gate still closes. Stranding
  // every pending approval would make the recovery worse than the incident,
  // and a decision is a human's judgement, not new work for Maestro to do.
  const killSwitch = await deps.killSwitch.get();
  if (killSwitch.level === "all" && !isGateDecision(command.name)) {
    deps.counters.droppedKillSwitch += 1;
    await reply(deps, ticket, BFF_MESSAGE_KEYS.killSwitch, {
      level: killSwitch.level,
      reason: killSwitch.reason,
    });
    return { accepted: false, command: command.name, reason: "kill_switch" };
  }

  // The author is unvalidated input from the Jira instance. An actor the audit
  // trail cannot classify must not reach it — an unattributable approval is
  // worse than none (M33) — but it must not become a 5xx either, because Jira
  // retries those forever. The person is told; the delivery is accepted.
  const actor = toActorOrNull(author, deps.config.actorDomain);
  if (actor === null) {
    await replyIfRenderable(deps, ticket, BFF_MESSAGE_KEYS.commandUnknownActor, {
      command: `/${command.name}`,
    });
    return { accepted: false, command: command.name, reason: "unknown_actor" };
  }

  switch (command.name) {
    case "approve":
    case "reject":
      return gateCommand(deps, {
        ticket,
        name: command.name,
        actor,
        membershipId: author,
        at,
        ...(command.name === "reject" ? { reason: command.reason } : {}),
      });

    case "status":
      return statusCommand(deps, ticket);

    case "mode-change":
      return modeCommand(deps, { ticket, mode: command.mode, actor, at, command: "mode-change" });

    // M46: the human takes the keyboard. There is no dedicated signal — the
    // work mode IS the takeover, and `human_lead` is what it means.
    case "ai-takeover":
      return modeCommand(deps, {
        ticket,
        mode: "human_lead",
        actor,
        at,
        command: "ai-takeover",
      });

    case "ai-start": {
      // The comment says only "/ai-start"; the delivery that carried it is a
      // COMMENT event, so it holds no issue fields to classify the ticket by.
      // Without the read below this command matched no listening rule and ran
      // the deployment default — the same defect the Studio Start button had,
      // and the one that cost OPS-57 its status map. See `classifyingFields`.
      const outcome = await runIntake(deps, {
        ticket,
        explicit: true,
        actor,
        ...(await classifyingFields(deps, ticket)),
      });
      return intakeCommand(deps, "ai-start", outcome, ticket);
    }

    case "ai-assign": {
      // Same read, same reason: naming the APPLICATION does not name the flow,
      // and `/ai-assign` is otherwise as blind to the ticket as `/ai-start`.
      const outcome = await runIntake(deps, {
        ticket,
        explicit: true,
        appId: command.appId,
        actor,
        ...(await classifyingFields(deps, ticket)),
      });
      if (outcome.accepted) {
        await deps.audit.append({
          actor,
          action: "ASSIGN_APP",
          subject: ticket,
          at,
          meta: { appId: command.appId, source: "jira" },
        });
      }
      return intakeCommand(deps, "ai-assign", outcome, ticket);
    }

    // No workflow signal exists for an explanation request yet (see RAPOR).
    // Saying so is the honest answer; pretending to accept it is not.
    case "ai-explain":
      await reply(deps, ticket, BFF_MESSAGE_KEYS.commandUnsupported, { command: "/ai-explain" });
      return { accepted: false, command: command.name, reason: "unsupported" };
  }
}

interface GateCommandInput {
  ticket: TicketKey;
  name: "approve" | "reject";
  actor: string;
  membershipId: string;
  at: string;
  reason?: string;
}

async function gateCommand(deps: ResolvedDeps, input: GateCommandInput): Promise<CommandOutcome> {
  const result: GateResult = await decideGate(deps, {
    ticket: input.ticket,
    decision: input.name,
    actor: input.actor,
    membershipId: input.membershipId,
    source: "jira",
    at: input.at,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  });

  if (!result.ok) {
    await replyGateFailure(deps, input.ticket, result);
    return { accepted: false, command: input.name, reason: result.reason };
  }

  if (input.name === "approve") {
    await reply(deps, input.ticket, BFF_MESSAGE_KEYS.gateApproved, {
      gate: deps.messages.t(deps.config.locale, stepTitleKey(result.step)),
      actor: input.actor,
      seq: String(result.signatureSeq),
    });
  } else {
    await reply(deps, input.ticket, BFF_MESSAGE_KEYS.gateRejected, {
      gate: deps.messages.t(deps.config.locale, stepTitleKey(result.step)),
    });
  }
  return { accepted: true, command: input.name, workflowId: workflowIdFor(input.ticket) };
}

async function replyGateFailure(
  deps: ResolvedDeps,
  ticket: TicketKey,
  result: Extract<GateResult, { ok: false }>,
): Promise<void> {
  if (result.reason === "not_member") {
    await reply(deps, ticket, BFF_MESSAGE_KEYS.gateMembershipFailed, { group: result.group ?? "" });
    return;
  }
  if (result.reason === "no_run" || result.reason === "not_delivered") {
    await reply(deps, ticket, BFF_MESSAGE_KEYS.commandNoRun, { ticket });
    return;
  }
  await reply(deps, ticket, BFF_MESSAGE_KEYS.commandNoOpenGate, { ticket });
}

async function statusCommand(deps: ResolvedDeps, ticket: TicketKey): Promise<CommandOutcome> {
  const state = await deps.runs.queryRunState(workflowIdFor(ticket));
  if (state === null) {
    await reply(deps, ticket, BFF_MESSAGE_KEYS.commandNoRun, { ticket });
    return { accepted: false, command: "status", reason: "no_run" };
  }
  await reply(deps, ticket, BFF_MESSAGE_KEYS.commandRunStatus, {
    ticket,
    step: deps.messages.t(deps.config.locale, stepTitleKey(state.step)),
    status: state.status,
  });
  return { accepted: true, command: "status" };
}

interface ModeCommandInput {
  ticket: TicketKey;
  mode: WorkMode;
  actor: string;
  at: string;
  command: CommandName;
}

async function modeCommand(deps: ResolvedDeps, input: ModeCommandInput): Promise<CommandOutcome> {
  const { ticket, mode, actor, at, command } = input;
  const workflowId = workflowIdFor(ticket);
  const delivered = await deps.runs.signal(workflowId, SIGNALS.modeChange, { mode, actor });
  if (delivered === "no_run") {
    await reply(deps, ticket, BFF_MESSAGE_KEYS.commandNoRun, { ticket });
    return { accepted: false, command, reason: "no_run" };
  }
  await deps.audit.append({
    actor,
    action: "MODE_CHANGED",
    subject: ticket,
    at,
    meta: { mode, command, source: "jira" },
  });
  await reply(deps, ticket, BFF_MESSAGE_KEYS.commandAccepted, { command: `/${command}` });
  return { accepted: true, command, workflowId };
}

async function intakeCommand(
  deps: ResolvedDeps,
  command: CommandName,
  outcome: IntakeOutcome,
  ticket: TicketKey,
): Promise<CommandOutcome> {
  if (!outcome.accepted) {
    /**
     * Answer ON THE TICKET, where the person who typed the command is looking.
     *
     * `kill_switch` and `no_application` already comment from inside intake;
     * these two returned in silence, so a `/ai-start` on a fresh install
     * produced no comment, no run and no visible trace — the operator's first
     * attempt simply vanished. Refusing is fine; refusing invisibly is not.
     */
    /**
     * `unbound` is NOT answered, deliberately — see this file's header (M102).
     * The single global webhook sees every project in the instance, so a reply
     * would tell the author that Maestro is watching a project it was never
     * bound to. That silence is a decision, not an oversight.
     *
     * `not_opted_in` is different: the project IS bound, the author is entitled
     * to know the platform is there, and the only thing missing is a label they
     * can add themselves. Leaving that one silent made a `/ai-start` look like
     * a platform that was down.
     */
    if (outcome.reason === "not_opted_in") {
      await reply(deps, ticket, BFF_MESSAGE_KEYS.intakeNotOptedIn, {
        ticket,
        label: deps.config.optInLabel,
      });
    }
    return { accepted: false, command, reason: outcome.reason };
  }
  await reply(deps, ticket, BFF_MESSAGE_KEYS.commandAccepted, { command: `/${command}` });
  return { accepted: true, command, workflowId: outcome.workflowId };
}
