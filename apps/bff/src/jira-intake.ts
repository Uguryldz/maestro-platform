import { ProjectKey, type TicketKey, type TicketSnapshot } from "@maestro/contracts";
import type { ResolvedDeps } from "./deps.js";
import { badRequest } from "./errors.js";
import { BFF_MESSAGE_KEYS } from "./messages.js";
import { workflowIdFor } from "./gateway.js";
import { flowDecisionFor, type FlowDecision } from "./flow-decision.js";

/**
 * Intake: the decision to put a ticket on the workflow engine, and every
 * reason not to. Nothing here guesses — an unmatched ticket goes to the human
 * assignment queue rather than to a default application (M14/M99).
 */

export interface IntakeRequest {
  ticket: TicketKey;
  labels?: readonly string[];
  /**
   * A person asked for this run by name (`/ai-start`, `/ai-assign`), so the
   * opt-in label rule has already been satisfied by the command itself (M48a).
   */
  explicit?: boolean;
  /** `/ai-assign <app>` — overrides the RoutingRule outcome (M99 tier ③). */
  appId?: string;
  /** Audit actor: the requesting human, or `maestro-worker` for a webhook. */
  actor: string;
  /**
   * The ticket's current status name, when the caller knows it. Together with
   * `issueType` and `assignee` it decides which FLOW this ticket runs
   * (`flow-decision.ts`). Absent means "not known here", which matches no rule
   * and falls back to the deployment default — so a caller that cannot supply
   * these (an operator pressing Start in Studio) behaves exactly as before.
   */
  status?: string;
  /** The ticket's issue-type name, when the caller knows it. */
  issueType?: string;
  /** The account the ticket is assigned to, when the caller knows it. */
  assignee?: string;
}

export type IntakeRefusal = "unbound" | "not_opted_in" | "kill_switch" | "no_application";

export type IntakeOutcome =
  | { accepted: true; workflowId: string; started: boolean }
  | { accepted: false; reason: IntakeRefusal };

export function projectKeyOf(ticket: TicketKey): string {
  const parsed = ProjectKey.safeParse(ticket.split("-")[0]);
  if (!parsed.success) throw badRequest("ticket_key", { ticket });
  return parsed.data;
}

/**
 * The fields a listening rule matches on, READ from the ticket, for the callers
 * that were not handed them.
 *
 * The webhook knows `issueType`/`assignee`/`labels` because the delivery
 * carries them. Every other entry point — Studio's Start button, `/ai-start`
 * and `/ai-assign` from a Jira comment, the MCP operate tools — knows only a
 * ticket key, and a caller that omits these matches NO rule: `matches()` in
 * `flow-decision.ts` compares them against `null`, so the ticket falls through
 * to the deployment default and loses both the rule's flow and its status map.
 * Measured on the live board: OPS-57 was hand-started under a project whose OPS
 * rule carries a full map, and the ticket never moved — no transition, no
 * status journal line, and nothing on the run to say why.
 *
 * So the hand paths ASK. One read of the ticket buys them the same rule
 * matching the webhook has always had, and the two entry points stop running
 * the same ticket under two different flows.
 *
 * Best-effort by construction. A Jira that will not answer costs rule matching
 * — which is exactly the behaviour these callers had before this existed — and
 * must not cost the run: refusing a hand start because a snapshot read failed
 * would turn a degraded Jira into an operator who cannot start anything.
 *
 * `onError` is where a caller that HAS a logger writes the reason down; there
 * is no logger on `ResolvedDeps`, so this seam cannot write one itself. It is
 * optional because two of the three callers genuinely have nowhere to put it:
 * a Jira comment command and an MCP tool both run outside a request. That is
 * not a quiet failure in the M14 sense — the fallback is recorded where an
 * operator actually looks for it, in the `RUN_STARTED` audit entry, whose
 * `flowReason` reads `default` instead of `rule`.
 *
 * `status` is deliberately NOT among them. The frozen `TicketSnapshot`
 * (M46/M102) carries no status field, so a `matchKind: "status"` rule still
 * cannot match on these paths. Rules keyed on issue type or assignee — the
 * shape the platform seeds — now do, and inventing a status here would be
 * worse than admitting we do not know it.
 */
export async function classifyingFields(
  deps: ResolvedDeps,
  ticket: TicketKey,
  onError: (error: unknown) => void = () => {},
): Promise<Pick<IntakeRequest, "issueType" | "labels" | "assignee">> {
  let snapshot: TicketSnapshot;
  try {
    snapshot = await deps.work.getTicket(ticket);
  } catch (error) {
    onError(error);
    return {};
  }
  return {
    issueType: snapshot.issueType,
    labels: snapshot.labels,
    // Omitted rather than sent as null, for the reason `flow` and `statusMap`
    // are omitted below: `assignee` is an OPTIONAL field whose absence already
    // means "not known here", and `IntakeRequest` has no null to give it.
    ...(snapshot.assignee === null ? {} : { assignee: snapshot.assignee }),
  };
}

export async function runIntake(deps: ResolvedDeps, request: IntakeRequest): Promise<IntakeOutcome> {
  const projectKey = projectKeyOf(request.ticket);

  // M102: one global webhook delivers every project's traffic; a project that
  // was never bound, or was paused, is dropped without a trace in Jira — the
  // counter is the trace. Answering an unbound project would leak that Maestro
  // is watching it.
  const binding = await deps.bindings.resolve(projectKey);
  if (binding === null || !binding.active) {
    deps.counters.droppedUnbound += 1;
    return { accepted: false, reason: "unbound" };
  }

  if (
    request.explicit !== true &&
    binding.triggerMode === "opt_in" &&
    !(request.labels ?? []).includes(deps.config.optInLabel)
  ) {
    return { accepted: false, reason: "not_opted_in" };
  }

  // M58: both levels stop new work. `all` also stops running work, but that is
  // the workflow's job — here the only question is whether to take the ticket.
  const killSwitch = await deps.killSwitch.get();
  if (killSwitch.level !== "off") {
    deps.counters.droppedKillSwitch += 1;
    await deps.work.addComment(
      request.ticket,
      deps.messages.t(deps.config.locale, BFF_MESSAGE_KEYS.killSwitch, {
        level: killSwitch.level,
        reason: killSwitch.reason,
      }),
    );
    return { accepted: false, reason: "kill_switch" };
  }

  // WHICH FLOW — decided here, before the run exists, and passed IN.
  //
  // It cannot be decided inside the workflow: `packages/workflows` may not read
  // a database (M44), and a workflow that re-read the rules on replay would
  // take a different path the moment an admin edited a rule. So the rules are
  // read once, on the way in, and the answer travels in the start input — the
  // same shape `openGate` uses to hand a resolved directory group to
  // `canCloseGate` (HANDOFF item 2).
  //
  // Decided BEFORE the application check below, because the application check
  // now depends on it: whether "no application" is a refusal is a question
  // about which flow would run.
  const flowDecision = await decideFlow(deps, request, projectKey);

  const appId = request.appId ?? binding.appId;
  if (appId === null || appId === undefined) {
    // Tier ③ of M99, narrowed to the flows it was written for: no rule matched
    // an application and no human said which one, so a flow that WRITES CODE
    // waits for a person rather than starting against a guess. The `analiz`
    // flow is the deliberate exception — an analysis-only binding carries no
    // application at all, the document is written from the ticket text, and
    // refusing it would force an analysis team to bind a repository they do
    // not own.
    if (flowDecision.flow !== "analiz") {
      await deps.work.addComment(
        request.ticket,
        deps.messages.t(deps.config.locale, BFF_MESSAGE_KEYS.pendingAssignment, {
          ticket: request.ticket,
        }),
      );
      return { accepted: false, reason: "no_application" };
    }
  }

  const outcome = await deps.runs.signalWithStart({
    ticket: request.ticket,
    // Omitted rather than sent as null for an analysis-only start: absence is
    // what the workflow reads as "no application", and `StartRunInput` has no
    // null to give it.
    ...(appId === null || appId === undefined ? {} : { appId }),
    mode: binding.mode,
    dataClass: binding.dataClass,
    ...(flowDecision.flow === null ? {} : { flow: flowDecision.flow }),
    // Omitted rather than sent as null when the rule maps nothing, for the
    // same reason `flow` is: absent already MEANS comment-only mode, and an
    // explicit null would say the same thing while looking like a choice
    // somebody made.
    ...(flowDecision.statusMap === undefined || flowDecision.statusMap === null
      ? {}
      : { statusMap: flowDecision.statusMap }),
  });

  if (outcome.started) {
    await deps.audit.append({
      actor: request.actor,
      action: "RUN_STARTED",
      subject: request.ticket,
      at: deps.clock.now(),
      meta: {
        workflowId: outcome.workflowId,
        projectKey,
        // An analysis-only start has no application, and the audit row says so
        // in words rather than holding a null a SIEM query would drop: "which
        // app did OPS-41 run against?" must be answerable with "none — ticket-
        // text analysis" months later.
        appId: appId ?? "yok (analiz, ticket metninden)",
        mode: binding.mode,
        dataClass: binding.dataClass,
        assigned: request.appId !== undefined,
        // WHY this ticket runs the flow it does. An operator asking months
        // later "why did OPS-41 write code?" reads it off the audit chain; a
        // log line would be long gone, and the run row records only the flow,
        // not the reason for it.
        flow: flowDecision.flow ?? "varsayilan",
        flowReason: flowDecision.reason,
        ...(flowDecision.ruleId === undefined ? {} : { flowRuleId: flowDecision.ruleId }),
        ...(flowDecision.conflictingRuleIds === undefined
          ? {}
          : { flowConflictingRuleIds: flowDecision.conflictingRuleIds.join(",") }),
        /**
         * WHICH board columns this run was pinned to, recorded next to the
         * flow that was pinned with them. A ticket that moved to a status
         * nobody expected is answered from here — the rule may have been
         * edited since, and the map that actually drove this run is otherwise
         * unrecoverable. Comment-only mode is recorded too, as "yorum" (there
         * IS no map), because "the operator configured nothing" and "the
         * audit did not say" have to be distinguishable.
         */
        statusMap:
          flowDecision.statusMap === undefined || flowDecision.statusMap === null
            ? "yorum"
            : JSON.stringify(flowDecision.statusMap),
      },
    });

    /**
     * Say ON THE TICKET that the work was picked up.
     *
     * Reported from the field: an operator assigned a ticket to the bot, the
     * sweep took it, a run started — and Jira showed nothing at all. From
     * where they were sitting, assigning the ticket had done nothing; the only
     * evidence lived in a panel they had no reason to open yet.
     *
     * Only on `started`. A delivery that JOINED a run already going has
     * nothing new to announce, and a second "picked this up" comment on the
     * same ticket reads as the platform having lost track of itself.
     *
     * Fail-soft: the run is under way and a comment that could not be posted
     * must not undo it. Jira being briefly unreachable is not a reason to
     * refuse work it already accepted.
     */
    await deps.work
      .addComment(
        request.ticket,
        deps.messages.t(deps.config.locale, BFF_MESSAGE_KEYS.intakeAccepted, {
          ticket: request.ticket,
        }),
      )
      .catch(() => undefined);
  }

  return { accepted: true, workflowId: outcome.workflowId ?? workflowIdFor(request.ticket), started: outcome.started };
}

/**
 * Which flow this ticket runs, and why.
 *
 * The rule set is read from the listening store — the rows an admin edits in
 * Studio — and matched against the ticket the caller described. Two things make
 * this SAFE to fall back rather than refuse:
 *
 *  - A deployment with no `ListeningStore` wired (the store is optional, like
 *    every other capability the composition root may omit) has no rules to
 *    read, so every ticket takes the deployment default. That is exactly the
 *    behaviour before this existed.
 *  - A store that FAILS to answer is treated the same way. A database blip must
 *    not stop a ticket that would otherwise run: the deployment default is a
 *    deliberate operator choice, not a guess, so falling back to it is safer
 *    than refusing the intake or inventing a flow.
 */
async function decideFlow(
  deps: ResolvedDeps,
  request: IntakeRequest,
  projectKey: string,
): Promise<FlowDecision> {
  const fallback = (): FlowDecision =>
    deps.config.defaultFlow === undefined || deps.config.defaultFlow === null
      ? { flow: null, reason: "none" }
      : { flow: deps.config.defaultFlow, reason: "default" };

  if (deps.listening === undefined) return fallback();

  let rules;
  try {
    rules = await deps.listening.list();
  } catch {
    return fallback();
  }

  return flowDecisionFor(
    rules,
    {
      projectKey,
      status: request.status ?? null,
      issueType: request.issueType ?? null,
      assignee: request.assignee ?? null,
    },
    deps.config.defaultFlow,
  );
}
