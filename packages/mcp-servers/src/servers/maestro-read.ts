import { AppId, RunId, TicketKey, WorkflowRunStatus } from "@maestro/contracts";
import { z } from "zod";
import { allowedOnIdeChannel } from "../ide-boundary.js";
import { defineTool, type ToolDefinition } from "../tool.js";
import type { MaestroPlatform } from "./maestro-platform.js";

const MAX_RUNS = 100;
const MAX_JOURNAL = 200;
const MAX_HITS = 50;
const MAX_GATES = 100;
const MAX_RUNNERS = 200;

/**
 * The `read` half of `maestro-mcp` (M101: "workflow durumu, journal, param,
 * kota, runner sağlığı, bekleyen kapılar").
 *
 * `list_pending_gates` is the tool that makes the absence of `approve_gate`
 * workable rather than merely principled: an operator can ask which gates are
 * stuck, who owns each one and how long it has been waiting, and then go and
 * talk to that person. Seeing a gate has never been the risk; closing one is.
 */
export function maestroReadTools(platform: MaestroPlatform): ToolDefinition[] {
  return [
    defineTool({
      name: "list_runs",
      description: "Workflow runs, optionally filtered by status, ticket or application.",
      scope: "read",
      input: z.object({
        status: WorkflowRunStatus.optional(),
        ticketKey: TicketKey.optional(),
        appId: AppId.optional(),
        limit: z.number().int().positive().max(MAX_RUNS).default(25),
      }),
      subject: (args) => args.ticketKey ?? args.appId ?? "(all runs)",
      handler: async (args, ctx) =>
        platform.listRuns(ctx.caller.user, {
          status: args.status,
          ticketKey: args.ticketKey,
          appId: args.appId,
          limit: args.limit,
        }),
    }),
    defineTool({
      name: "get_run",
      description: "One run: current step, status, risk tier, work mode and the gate it is waiting on.",
      scope: "read",
      input: z.object({ runId: RunId }),
      subject: (args) => args.runId,
      handler: async (args, ctx) => platform.getRun(ctx.caller.user, args.runId),
    }),
    defineTool({
      name: "get_journal",
      description: "Ticket journal entries for a run, in sequence order (M30).",
      scope: "read",
      input: z.object({
        runId: RunId,
        fromSeq: z.number().int().nonnegative().default(0),
        limit: z.number().int().positive().max(MAX_JOURNAL).default(50),
      }),
      subject: (args) => args.runId,
      handler: async (args, ctx) =>
        platform.getJournal(ctx.caller.user, args.runId, { fromSeq: args.fromSeq, limit: args.limit }),
    }),
    defineTool({
      name: "get_params",
      description: "Operational parameters and their current values, by scope (M71).",
      scope: "read",
      input: z.object({
        scope: z.enum(["global", "project", "application"]).optional(),
        scopeRef: z.string().trim().min(1).max(120).optional(),
      }),
      subject: (args) => args.scopeRef ?? args.scope ?? "(all scopes)",
      handler: async (args, ctx) =>
        platform.getParams(ctx.caller.user, { scope: args.scope, scopeRef: args.scopeRef }),
    }),
    defineTool({
      name: "get_repo_card",
      description: "Repo card of an application: module map and summaries used for cross-app impact (M100).",
      scope: "read",
      input: z.object({ appId: AppId }),
      subject: (args) => args.appId,
      handler: async (args, ctx) => platform.getRepoCard(ctx.caller.user, args.appId),
    }),
    defineTool({
      name: "search_knowledge",
      description: "Search the knowledge base: repo cards, past analyses, decision records.",
      scope: "read",
      input: z.object({
        text: z.string().trim().min(2).max(400),
        appId: AppId.optional(),
        limit: z.number().int().positive().max(MAX_HITS).default(10),
      }),
      subject: (args) => args.appId ?? "(knowledge)",
      handler: async (args, ctx) => {
        const hits = await platform.searchKnowledge(ctx.caller.user, {
          text: args.text,
          appId: args.appId,
          limit: args.limit,
        });
        // B9 — a `gizli` document is dropped from THIS channel, not tokenised.
        // Masking removes identifiers; it does not make a confidential document
        // safe to place on a personal laptop. See `src/ide-boundary.ts`.
        return hits.filter(allowedOnIdeChannel);
      },
    }),
    defineTool({
      name: "list_pending_gates",
      description:
        "Gates waiting on a human: which run, which step, which group owns it and how long it has waited. Read-only — MCP cannot decide a gate (M32).",
      scope: "read",
      input: z.object({
        ownerGroup: z.string().trim().min(1).max(120).optional(),
        olderThanDays: z.number().int().nonnegative().max(3650).optional(),
        limit: z.number().int().positive().max(MAX_GATES).default(25),
      }),
      subject: (args) => args.ownerGroup ?? "(all gates)",
      handler: async (args, ctx) =>
        platform.listPendingGates(ctx.caller.user, {
          ownerGroup: args.ownerGroup,
          olderThanDays: args.olderThanDays,
          limit: args.limit,
        }),
    }),
    defineTool({
      name: "quota_status",
      description: "LLM/token budget: what has been spent in the current window, and whether it is throttled.",
      scope: "read",
      input: z.object({
        scope: z.enum(["global", "project", "application"]).optional(),
        scopeRef: z.string().trim().min(1).max(120).optional(),
      }),
      subject: (args) => args.scopeRef ?? args.scope ?? "(all scopes)",
      handler: async (args, ctx) =>
        platform.quotaStatus(ctx.caller.user, { scope: args.scope, scopeRef: args.scopeRef }),
    }),
    defineTool({
      name: "runner_health",
      description: "Runner fleet: state, active sandboxes and last heartbeat, per runner.",
      scope: "read",
      input: z.object({ limit: z.number().int().positive().max(MAX_RUNNERS).default(50) }),
      subject: () => "(runners)",
      handler: async (args, ctx) => (await platform.runnerHealth(ctx.caller.user)).slice(0, args.limit),
    }),
  ];
}
