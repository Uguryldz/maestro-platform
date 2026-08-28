import { TicketKey, WorkMode } from "@maestro/contracts";
import type { MaestroPlatform } from "@maestro/mcp-servers";
import type { ResolvedDeps } from "../deps.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { workflowIdFor } from "../gateway.js";
import { classifyingFields, runIntake } from "../jira-intake.js";
import { BFF_MESSAGE_KEYS } from "../messages.js";
import { assertProjectAccess } from "../routes/access.js";
import { SIGNALS } from "../signal-names.js";
import { scopeOf } from "./actor-scope.js";
import { assertWritable } from "./propose.js";
import { runOf } from "./run-lookup.js";

/**
 * The operate half of `MaestroPlatform` (M101). These methods change something,
 * so each one carries the three checks the REST surface carries: the caller's
 * project access, the kill switch, and an audit record written before the
 * effect rather than after it.
 *
 * The two PROPOSAL tools live in `propose.ts` — they file a change for a human
 * to confirm rather than making one, which is a different rule about a
 * different thing.
 *
 * What is NOT here is the point. No method closes a gate, sets a verdict or
 * merges a PR — a decision reaches the workflow as a signal from a human
 * channel, and there is no shape on this interface that could carry one.
 */

export type OperateHalf = Pick<
  MaestroPlatform,
  | "startWorkflow"
  | "assignApp"
  | "setWorkMode"
  | "pauseRun"
  | "resumeRun"
  | "retryStep"
  | "notifyGateOwner"
>;

/**
 * Every method the kill switch must stop, named once.
 *
 * `killSwitched` reads this list rather than each method remembering to call
 * `assertWritable` itself. The first version of this file did it the other way
 * — a call at the top of each body — and `notifyGateOwner` was written without
 * one, so an AI could still post to the bank's Jira with the platform stopped.
 * A per-method call is a rule you can comply with six times out of seven and a
 * gate is a rule you cannot; the whole point of a kill switch is that the
 * method somebody forgets is the method that runs during the incident.
 *
 * A new operate method is covered the moment it is added to `OperateHalf`:
 * `Record<keyof OperateHalf, true>` fails to compile without an entry here.
 */
const KILL_SWITCHED: Record<keyof OperateHalf, true> = {
  startWorkflow: true,
  assignApp: true,
  setWorkMode: true,
  pauseRun: true,
  resumeRun: true,
  retryStep: true,
  notifyGateOwner: true,
};

/** The operate method names, for the gate and for the test that audits it. */
export const OPERATE_METHODS = Object.keys(KILL_SWITCHED) as readonly (keyof OperateHalf)[];

/**
 * Wrap every operate method in the kill-switch check.
 *
 * The check runs BEFORE the wrapped body, so a stopped platform costs a store
 * read and nothing else: no session lookup, no read-model query and above all
 * no outbound call. The wrapper is applied to the whole object rather than
 * mapped by name, so a method that exists at runtime but was never listed
 * cannot slip through un-gated.
 */
function killSwitched(deps: ResolvedDeps, half: OperateHalf): OperateHalf {
  const gated: Record<string, unknown> = {};
  for (const name of OPERATE_METHODS) {
    const method = half[name] as (...args: readonly unknown[]) => Promise<unknown>;
    gated[name] = async (...args: readonly unknown[]): Promise<unknown> => {
      await assertWritable(deps);
      return method(...args);
    };
  }
  return gated as unknown as OperateHalf;
}

export function operateHalf(deps: ResolvedDeps): OperateHalf {
  return killSwitched(deps, rawOperateHalf(deps));
}

/**
 * The bodies, without the kill-switch check — `killSwitched` supplies it.
 * Exported for no one: it exists so the gate has something to wrap, and a
 * caller reaching for it directly would be reaching past the switch.
 */
function rawOperateHalf(deps: ResolvedDeps): OperateHalf {
  return {
    async startWorkflow(actingUser, args): Promise<{ runId: string; ticketKey: string }> {
      const session = await scopeOf(deps, actingUser);
      const ticket = ticketOf(args.ticketKey);
      assertProjectAccess(session, ticket);

      // The same intake the Jira command path uses, so an unbound project is
      // refused here too (M102). A tool that could start a run in a project
      // nobody bound would be a way around the binding entirely.
      //
      // And the same ticket read, for the same reason: an MCP tool is handed a
      // ticket key and nothing else, so without it this run matches no
      // listening rule and loses the rule's flow and status map
      // (`classifyingFields`). A run started from a chat client must not take a
      // different path through the board than the same ticket started anywhere
      // else.
      const outcome = await runIntake(deps, {
        ticket,
        explicit: true,
        actor: actingUser,
        ...(await classifyingFields(deps, ticket)),
      });
      if (!outcome.accepted) throw conflict(`intake_${outcome.reason}`, { ticket });

      const state = await deps.runs.queryRunState(outcome.workflowId);
      if (state === null) throw notFound("no_run", { ticket });

      if (args.mode !== undefined) {
        await signalMode(deps, ticket, args.mode, actingUser);
      }
      return { runId: state.runId, ticketKey: ticket };
    },

    async assignApp(actingUser, args): Promise<{ ticketKey: string; appId: string }> {
      const session = await scopeOf(deps, actingUser);
      const ticket = ticketOf(args.ticketKey);
      assertProjectAccess(session, ticket);

      // An application that is not in the registry is not an assignment, it is
      // a typo that would start a run against a repository nobody onboarded.
      if ((await deps.read.apps.get(args.appId)) === null) {
        throw notFound("unknown_app", { appId: args.appId });
      }

      const outcome = await runIntake(deps, {
        ticket,
        explicit: true,
        appId: args.appId,
        actor: actingUser,
        // Naming the application does not name the flow — see `startWorkflow`.
        ...(await classifyingFields(deps, ticket)),
      });
      if (!outcome.accepted) throw conflict(`intake_${outcome.reason}`, { ticket });

      await deps.audit.append({
        actor: actingUser,
        action: "ASSIGN_APP",
        subject: ticket,
        at: deps.clock.now(),
        meta: { appId: args.appId, source: "mcp" },
      });
      return { ticketKey: ticket, appId: args.appId };
    },

    async setWorkMode(actingUser, args): Promise<{ runId: string; mode: WorkMode }> {
      const session = await scopeOf(deps, actingUser);
      const { record } = await runOf(deps, session, args.runId);

      await signalMode(deps, record.ticketKey, args.mode, actingUser, args.reason);
      return { runId: args.runId, mode: args.mode };
    },

    /**
     * Pause and resume are `modeChange` signals to `human_only` and back, not a
     * separate control plane: the workflow already knows how to stop handing
     * work to an agent, and a second mechanism would be a second thing that can
     * disagree about whether a run is moving.
     */
    async pauseRun(actingUser, args): Promise<{ runId: string; status: string }> {
      const session = await scopeOf(deps, actingUser);
      const { record } = await runOf(deps, session, args.runId);

      await signalMode(deps, record.ticketKey, "human_only", actingUser, args.reason);
      return { runId: args.runId, status: "paused" };
    },

    async resumeRun(actingUser, args): Promise<{ runId: string; status: string }> {
      const session = await scopeOf(deps, actingUser);
      const { record } = await runOf(deps, session, args.runId);

      // Back to the mode the run was matched with, not to `full_auto`: resuming
      // must not be a quiet promotion of how much the AI is allowed to do.
      await signalMode(deps, record.ticketKey, record.mode, actingUser, args.reason);
      return { runId: args.runId, status: "resumed" };
    },

    async retryStep(
      actingUser,
      args,
    ): Promise<{ runId: string; step: string; attempt: number }> {
      const session = await scopeOf(deps, actingUser);
      const { record, state } = await runOf(deps, session, args.runId);

      // Only the step the run is actually on. Retrying a step it has moved past
      // would rewind work that later steps already built on.
      if (state.step !== args.step) {
        throw conflict("step_not_current", { step: state.step });
      }

      const delivered = await deps.runs.signal(workflowIdFor(record.ticketKey), SIGNALS.modeChange, {
        mode: record.mode,
        actor: actingUser,
        retryStep: args.step,
        reason: args.reason,
      });
      if (delivered === "no_run") throw notFound("no_run", { runId: args.runId });

      await deps.audit.append({
        actor: actingUser,
        action: "MCP_TOOL_CALL",
        subject: record.ticketKey,
        at: deps.clock.now(),
        meta: { tool: "retry_step", step: args.step, reason: args.reason },
      });
      return { runId: args.runId, step: args.step, attempt: 1 };
    },

    /**
     * Nudges the gate's owner. Returns nothing about the gate's state on
     * purpose: this tool reminds, it does not decide, and a return value
     * carrying the gate's status would invite a caller to poll it as though a
     * reminder were a step towards approval.
     */
    async notifyGateOwner(
      actingUser,
      args,
    ): Promise<{ runId: string; step: string; notified: string }> {
      const session = await scopeOf(deps, actingUser);
      const { record } = await runOf(deps, session, args.runId);

      const gates = await deps.read.gates.listOpen({
        limit: 200,
        cursor: null,
        ownerGroup: null,
        projectKeys: null,
      });
      const gate = gates.items.find(
        (candidate) => candidate.ticketKey === record.ticketKey && candidate.step === args.step,
      );
      // No open gate at that step is a mistake to report, not a reason to send
      // somebody a reminder about a decision nobody is waiting for.
      if (gate === undefined) throw notFound("no_open_gate", { step: args.step });

      // The catalog sentence, never a literal (M104). A caller-supplied message
      // is passed through as the operator's own words; the default is the
      // platform speaking, and the platform speaks from the catalog.
      const days = Math.max(
        0,
        Math.floor((deps.clock.now().getTime() - Date.parse(gate.openedAt)) / 86_400_000),
      );
      await deps.work.addComment(
        record.ticketKey,
        args.message ??
          deps.messages.t(deps.config.locale, BFF_MESSAGE_KEYS.gateReminder, {
            ticket: record.ticketKey,
            gate: args.step,
            days: String(days),
          }),
      );
      await deps.audit.append({
        actor: actingUser,
        action: "MCP_TOOL_CALL",
        subject: record.ticketKey,
        at: deps.clock.now(),
        meta: { tool: "notify_gate_owner", step: args.step, group: gate.ownerGroup, by: session.username },
      });
      return { runId: args.runId, step: args.step, notified: gate.ownerGroup };
    },
  };
}

async function signalMode(
  deps: ResolvedDeps,
  ticket: string,
  mode: WorkMode,
  actor: string,
  reason?: string,
): Promise<void> {
  const parsed = WorkMode.safeParse(mode);
  if (!parsed.success) throw badRequest("invalid_mode");

  const delivered = await deps.runs.signal(workflowIdFor(ticket), SIGNALS.modeChange, {
    mode: parsed.data,
    actor,
    ...(reason === undefined ? {} : { reason }),
  });
  if (delivered === "no_run") throw notFound("no_run", { ticket });

  await deps.audit.append({
    actor,
    action: "MODE_CHANGED",
    subject: ticket,
    at: deps.clock.now(),
    meta: { mode: parsed.data, source: "mcp", ...(reason === undefined ? {} : { reason }) },
  });
}

/** The frozen contract's own validator — never a second regex that can drift. */
function ticketOf(ticketKey: string): TicketKey {
  const parsed = TicketKey.safeParse(ticketKey);
  if (!parsed.success) throw badRequest("invalid_ticket_key", { ticketKey });
  return parsed.data;
}
