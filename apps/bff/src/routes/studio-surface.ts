import { CommandName } from "@maestro/contracts";
import { FORBIDDEN_TOOL_NAMES, maestroMcpServer } from "@maestro/mcp-servers";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authGuard } from "../auth/guard.js";
import type { ResolvedDeps } from "../deps.js";
import { bffPlatform } from "../platform/index.js";

/**
 * Two surfaces described to Studio: the Jira command set and the MCP manifest.
 *
 * Both are PRODUCT RULES rather than data — there is no table behind either,
 * and there should not be. What matters is that neither is a hand-maintained
 * second copy: the commands are derived from `CommandName` (the frozen
 * contract the parser validates against) and the tools from the real
 * `maestro-mcp` `ServerDefinition`. A screen that documented a command the
 * parser does not accept, or hid a tool the server actually ships, would be
 * worse than no screen: it would be a security review passed against fiction.
 *
 * The compiler enforces the first half. `COMMAND_RULES` is keyed by
 * `CommandName`, so adding a ninth command to contracts breaks this file until
 * somebody says who may run it and when.
 */

/** Who may run a command, and the catalog keys describing when and what (M104). */
interface CommandRule {
  /** Empty = anyone with ticket access; the gate check is per-decision (M32). */
  readonly roles: readonly string[];
  readonly takesArgument: boolean;
  readonly whenKey: string;
  readonly effectKey: string;
}

/**
 * The command set (M46/M105).
 *
 * `roles` is what the SCREEN shows, and it is deliberately not the whole
 * authorisation story: `/approve` and `/reject` are additionally checked
 * against the gate's owner GROUP at decision time (`gate-decision.ts`), which
 * no static table can express. The screen's validation ladder says so; this
 * carries the coarse rule so an operator knows who to ask.
 *
 * `takesArgument` matches the parser exactly — `reject` needs a reason,
 * `ai-assign` an appId, `mode-change` a mode, and everything else must be the
 * bare command with nothing else in the comment. That last rule is the reason
 * `takesArgument` is here at all: for a no-argument command the whole comment
 * must BE the command, or "/approve etmiyorum" would read as consent.
 */
const COMMAND_RULES: Readonly<Record<CommandName, CommandRule>> = {
  approve: {
    roles: ["tech-lead", "product-owner", "qa"],
    takesArgument: false,
    whenKey: "commands.when.gate_open",
    effectKey: "commands.effect.approve",
  },
  reject: {
    roles: ["tech-lead", "product-owner", "qa"],
    takesArgument: true,
    whenKey: "commands.when.gate_open",
    effectKey: "commands.effect.reject",
  },
  status: {
    roles: [],
    takesArgument: false,
    whenKey: "commands.when.any",
    effectKey: "commands.effect.status",
  },
  "ai-explain": {
    roles: [],
    takesArgument: false,
    whenKey: "commands.when.any",
    effectKey: "commands.effect.ai_explain",
  },
  "ai-start": {
    roles: ["developer", "tech-lead"],
    takesArgument: false,
    whenKey: "commands.when.no_run",
    effectKey: "commands.effect.ai_start",
  },
  "ai-assign": {
    roles: ["developer", "tech-lead"],
    takesArgument: true,
    whenKey: "commands.when.unassigned",
    effectKey: "commands.effect.ai_assign",
  },
  "mode-change": {
    roles: ["developer", "tech-lead"],
    takesArgument: true,
    whenKey: "commands.when.run_live",
    effectKey: "commands.effect.mode_change",
  },
  "ai-takeover": {
    roles: ["developer", "tech-lead"],
    takesArgument: false,
    whenKey: "commands.when.run_live",
    effectKey: "commands.effect.ai_takeover",
  },
};

const CommandsOut = z
  .object({
    commands: z.array(
      z
        .object({
          name: z.string().min(1),
          roles: z.array(z.string().min(1)),
          takesArgument: z.boolean(),
          whenKey: z.string().min(1),
          effectKey: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

const McpOut = z
  .object({
    endpoint: z.string().min(1),
    auditActor: z.string().min(1),
    tools: z.array(
      z
        .object({
          name: z.string().min(1),
          scope: z.enum(["read", "operate", "admin-proposal"]),
          descriptionKey: z.string().min(1),
        })
        .strict(),
    ),
    forbiddenTools: z.array(z.string().min(1)).min(1),
  })
  .strict();

export async function studioSurfaceRoutes(app: FastifyInstance, deps: ResolvedDeps): Promise<void> {
  const preHandler = authGuard(deps);

  /**
   * The Jira command set (M46/M105). Any session may read it: it is the
   * documentation of a public interface — every one of these is typed into a
   * ticket comment — and hiding it would only mean people guess.
   *
   * Names come from the contract enum in its declared order, so the screen can
   * never list a command the parser would refuse, nor omit one it accepts.
   */
  app.get("/commands", { preHandler }, async (_request, reply) => {
    const commands = CommandName.options.map((name) => ({
      name: `/${name}`,
      ...COMMAND_RULES[name],
    }));
    return reply.code(200).send(CommandsOut.parse({ commands }));
  });

  /**
   * The `maestro-mcp` manifest (M101).
   *
   * Built from the REAL server definition — the same `ServerDefinition` the
   * transport binds and the runtime enforces scopes against — rather than from
   * a list typed out beside it. Two things have to be legible or the screen
   * misleads:
   *
   *  · every tool's SCOPE, because the effective permission is the caller's
   *    RBAC ∩ the tool's scope, and `admin-proposal` only ever QUEUES a change
   *    for a human;
   *  · the tools that do NOT exist. `approve_gate`, `reject_gate` and
   *    `merge_pr` are absent by construction (M32), and an operator who cannot
   *    see the boundary assumes there isn't one. `forbiddenTools` is therefore
   *    required non-empty by the schema above: an empty list here would render
   *    as "nothing is forbidden", which is the opposite of the truth.
   *
   * `descriptionKey` is a catalog key, never the tool's English description:
   * the BFF does not send prose (M104).
   */
  app.get("/mcp/manifest", { preHandler }, async (_request, reply) => {
    // The definition is derived from the same platform container Studio reads
    // through, so the manifest and the live server cannot describe different
    // tool sets.
    const definition = maestroMcpServer({ platform: bffPlatform(deps) });

    const tools = definition.tools.map((tool) => ({
      name: tool.name,
      scope: tool.scope,
      descriptionKey: `mcp.tool.${tool.name}`,
    }));

    return reply.code(200).send(
      McpOut.parse({
        endpoint: `${definition.name} · /mcp`,
        // What the audit chain records for a delegated call (M101): the AI has
        // no identity of its own, it borrows the caller's and the loan is what
        // gets written down.
        auditActor: "ai-via:<user>",
        tools,
        forbiddenTools: FORBIDDEN_TOOL_NAMES,
      }),
    );
  });
}
