import { type IdePiiOptions, maskForIde } from "../ide-boundary.js";
import { defineServer, type ServerDefinition, type ToolDefinition } from "../tool.js";
import type { MaestroPlatform } from "./maestro-platform.js";
import { maestroOperateTools } from "./maestro-operate.js";
import { maestroReadTools } from "./maestro-read.js";

export interface MaestroMcpDeps {
  readonly platform: MaestroPlatform;
  /**
   * The PII boundary for THIS channel (verifier B9). Optional, and off unless
   * the composition root supplies it — see `src/ide-boundary.ts` for why a
   * silent default would be worse than none.
   */
  readonly pii?: IdePiiOptions;
}

/**
 * `maestro-mcp` — the platform managing itself (M101).
 *
 * The other three servers face INTO a sandbox; this one faces a person's IDE.
 * Identity is the caller's personal token, the platform applies that person's
 * RBAC, and every call lands in the audit chain as `ai-via:<user>`.
 *
 * Because it faces an IDE, it is also the only one of the four whose results
 * leave the platform's LLM egress path: they land on a personal machine and go
 * on to whichever model that IDE is wired to. Every result therefore passes
 * through `maskForIde` on the way out when a policy is configured (B9).
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  WHAT IS NOT HERE, AND WHY:  approve_gate · reject_gate · merge_pr
 * ───────────────────────────────────────────────────────────────────────────
 * This server can tell you a run has been sitting on the PO gate for sixteen
 * days, who owns it, and what the analysis says. It can remind that owner. It
 * cannot close it. A gate decision carries a signature traced to a person and
 * verified against group membership (M32), and it may only arrive through a
 * channel a person controls: a Jira comment (M105) or Studio.
 * `GateDecision.source` has exactly those two values, and no third is coming.
 *
 * The guarantee is structural: `MaestroPlatform` has no method that decides a
 * gate, so no tool here can call one. `src/forbidden-tools.ts` is the name
 * safety net on top of that — it makes a maintainer reaching for the name hit
 * a boot failure rather than a code review.
 *
 * `propose_param_change` and `propose_killswitch` are the shape everything
 * write-adjacent takes on this server: they file a proposal into the four-eyes
 * queue and return the proposal, never an applied change. If a platform
 * implementation ever returns anything else, the tool refuses the result rather
 * than reporting it.
 */
export function maestroMcpServer(deps: MaestroMcpDeps): ServerDefinition {
  const tools = [...maestroReadTools(deps.platform), ...maestroOperateTools(deps.platform)];
  const pii = deps.pii;

  return defineServer({
    name: "maestro-mcp",
    version: "0.2.0",
    description: "Operate and inspect Maestro itself, with the calling user's own permissions.",
    tools: pii === undefined ? tools : tools.map((tool) => maskedTool(tool, pii)),
  });
}

/**
 * Wraps one tool's handler so its RESULT is masked on the way out.
 *
 * Applied to every tool rather than to the two the verifier named. `get_run`
 * carries a gate's owner group, `list_pending_gates` carries a ticket key, and
 * a proposal echoes back the reason a human typed — the leak is wherever
 * free text is, and enumerating "the risky ones" is how the next one gets
 * missed. The handler is wrapped, not the transport, so the masking survives
 * whichever transport the BFF binds.
 */
function maskedTool(tool: ToolDefinition, pii: IdePiiOptions): ToolDefinition {
  return {
    ...tool,
    handler: async (args, ctx) => maskForIde(await tool.handler(args, ctx), tool.name, pii),
  };
}
