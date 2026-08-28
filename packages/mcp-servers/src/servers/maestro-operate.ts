import { AppId, ParamKey, RunId, TicketKey, WorkMode } from "@maestro/contracts";
import { z } from "zod";
import { ToolPolicyError } from "../errors.js";
import { defineTool, type ToolDefinition } from "../tool.js";
import type { MaestroPlatform } from "./maestro-platform.js";

const MAX_REASON = 500;
const MAX_MESSAGE = 1000;

/** Every state-changing call carries a reason; a run's history is read by people. */
const Reason = z.string().trim().min(1).max(MAX_REASON);

/**
 * The `operate` and `admin-proposal` halves of `maestro-mcp` (M101).
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  `propose_killswitch`, NOT `toggle_killswitch`   (M58 · M32 · M101)
 * ───────────────────────────────────────────────────────────────────────────
 * The mock screen showed a toggle. It is not one here. M58's kill-switch stops
 * the platform — level ① refuses new work, level ② extinguishes every sandbox
 * and leaves every gate waiting — and M101 spells out "kill-switch = çift
 * onay". A single tool call from a model holding a borrowed token is one
 * approval at most, and the dangerous direction is not only "stop": RESUMING
 * after an incident, before anybody has established what happened, is how an
 * incident becomes two.
 *
 * So it takes the same shape as a guarded parameter: MCP files a proposal, a
 * second human approves it in Studio, and the tool refuses the platform's own
 * answer if that answer is anything other than "queued".
 *
 * `notify_gate_owner` is here for the opposite reason. It is the one thing MCP
 * may do about a stuck gate: remind the person who owns it. It carries no
 * verdict, returns nothing about the gate's state, and is the reason
 * `list_pending_gates` is useful rather than merely informative.
 */
export function maestroOperateTools(platform: MaestroPlatform): ToolDefinition[] {
  return [
    defineTool({
      name: "start_workflow",
      description: "Start the delivery flow for a ticket in an opted-in project.",
      scope: "operate",
      auditAction: "RUN_STARTED",
      input: z.object({ ticketKey: TicketKey, mode: WorkMode.optional() }),
      subject: (args) => args.ticketKey,
      handler: async (args, ctx) =>
        platform.startWorkflow(ctx.caller.user, { ticketKey: args.ticketKey, mode: args.mode }),
    }),
    defineTool({
      name: "assign_app",
      description: "Assign a ticket to an application — the human tier of matching (M99 tier ③).",
      scope: "operate",
      auditAction: "ASSIGN_APP",
      input: z.object({ ticketKey: TicketKey, appId: AppId }),
      subject: (args) => `${args.ticketKey}→${args.appId}`,
      handler: async (args, ctx) =>
        platform.assignApp(ctx.caller.user, { ticketKey: args.ticketKey, appId: args.appId }),
    }),
    defineTool({
      name: "set_workmode",
      description: "Change a run's work mode (M101 operate). The mode governs how much the AI does unattended.",
      scope: "operate",
      auditAction: "MODE_CHANGED",
      input: z.object({ runId: RunId, mode: WorkMode, reason: Reason }),
      subject: (args) => `${args.runId}→${args.mode}`,
      handler: async (args, ctx) =>
        platform.setWorkMode(ctx.caller.user, { runId: args.runId, mode: args.mode, reason: args.reason }),
    }),
    defineTool({
      name: "pause_run",
      description: "Pause a run. Gates it is waiting on stay open; nothing is decided by pausing.",
      scope: "operate",
      input: z.object({ runId: RunId, reason: Reason }),
      subject: (args) => args.runId,
      handler: async (args, ctx) =>
        platform.pauseRun(ctx.caller.user, { runId: args.runId, reason: args.reason }),
    }),
    defineTool({
      name: "resume_run",
      description: "Resume a paused run from where it stopped.",
      scope: "operate",
      input: z.object({ runId: RunId, reason: Reason }),
      subject: (args) => args.runId,
      handler: async (args, ctx) =>
        platform.resumeRun(ctx.caller.user, { runId: args.runId, reason: args.reason }),
    }),
    defineTool({
      name: "retry_step",
      description: "Re-run one step of a run after a transient failure. Does not skip a step, and never a gate.",
      scope: "operate",
      input: z.object({ runId: RunId, step: z.string().trim().min(1).max(40), reason: Reason }),
      subject: (args) => `${args.runId}#${args.step}`,
      handler: async (args, ctx) =>
        platform.retryStep(ctx.caller.user, { runId: args.runId, step: args.step, reason: args.reason }),
    }),
    defineTool({
      name: "notify_gate_owner",
      description:
        "Remind the group that owns a waiting gate. Sends a reminder only — it carries no approval and reports no verdict (M32).",
      scope: "operate",
      input: z.object({
        runId: RunId,
        step: z.string().trim().min(1).max(40),
        message: z.string().trim().min(1).max(MAX_MESSAGE).nullable().default(null),
      }),
      subject: (args) => `${args.runId}#${args.step}`,
      handler: async (args, ctx) =>
        platform.notifyGateOwner(ctx.caller.user, {
          runId: args.runId,
          step: args.step,
          message: args.message,
        }),
    }),
    defineTool({
      name: "propose_param_change",
      description:
        "File a parameter change into the four-eyes queue. The change is NOT applied; a second person approves it in Studio.",
      scope: "admin-proposal",
      // Deliberately NOT `PARAM_CHANGED`: nothing changed. An audit row
      // claiming a change for a proposal is the most misleading line the
      // chain could carry — see src/audit.ts.
      input: z.object({
        key: ParamKey,
        scopeRef: z.string().trim().min(1).max(120).nullable().default(null),
        value: z.unknown(),
        reason: Reason,
      }),
      subject: (args) => args.key,
      handler: async (args, ctx) => {
        const proposal = await platform.proposeParamChange(ctx.caller.user, {
          key: args.key,
          scopeRef: args.scopeRef,
          value: args.value,
          reason: args.reason,
        });
        // Fail-closed on the platform's own answer: a proposal that came
        // back as anything but "pending" means the four-eyes queue was
        // bypassed somewhere below, and reporting it as success would hide
        // exactly the event this guard exists to catch.
        if (proposal.status !== "pending_four_eyes") {
          throw new ToolPolicyError(
            "propose_param_change",
            "four_eyes_bypassed",
            `parameter "${args.key}" was not queued for approval; MCP may propose, never apply (M71/M101)`,
          );
        }
        return proposal;
      },
    }),
    defineTool({
      name: "propose_killswitch",
      description:
        "File a kill-switch change into the four-eyes queue (M58). The switch is NOT flipped; a second person approves it in Studio.",
      scope: "admin-proposal",
      // Not `KILL_SWITCH`: nothing was switched. That code belongs to the
      // worker activity that actually flips it, after the second approval.
      input: z.object({
        level: z.enum(["pause_intake", "stop_all"]),
        reason: Reason,
      }),
      subject: (args) => args.level,
      handler: async (args, ctx) => {
        const proposal = await platform.proposeKillSwitch(ctx.caller.user, {
          level: args.level,
          reason: args.reason,
        });
        if (proposal.status !== "pending_four_eyes") {
          throw new ToolPolicyError(
            "propose_killswitch",
            "four_eyes_bypassed",
            `kill-switch "${args.level}" was not queued for approval; MCP may propose, never flip (M58/M101)`,
          );
        }
        return proposal;
      },
    }),
  ];
}
