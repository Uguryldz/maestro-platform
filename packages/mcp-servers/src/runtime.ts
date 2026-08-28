import type { z } from "zod";
import { aiViaActor, type ToolAuditRecord, type ToolAuditSink, type ToolOutcome } from "./audit.js";
import {
  ScopeDeniedError,
  ToolAuditError,
  ToolInputError,
  ToolPolicyError,
  UnknownToolError,
} from "./errors.js";
import { assertNoGateDecisionTools } from "./forbidden-tools.js";
import { type CallerIdentity, hasScope, sealCaller, type ToolScope } from "./scopes.js";
import { defineServer, type ServerDefinition, type ToolDefinition } from "./tool.js";

export type ToolDenialReason = "unknown_tool" | "scope" | "invalid_input" | "policy";

export type ToolCallResult =
  | { readonly status: "ok"; readonly value: unknown }
  | { readonly status: "denied"; readonly reason: ToolDenialReason; readonly message: string };

export interface ToolListing {
  readonly name: string;
  readonly description: string;
  readonly scope: ToolScope;
  readonly input: z.ZodObject<z.ZodRawShape>;
}

export interface ServerRuntimeDeps {
  readonly audit: ToolAuditSink;
  readonly now: () => Date;
}

/** Subject placeholder for a call that never produced validated arguments. */
export const UNRESOLVED_SUBJECT = "(unresolved)";

/**
 * Transport-independent server runtime: name resolution, scope enforcement,
 * schema validation, handler dispatch and the audit record — in that order,
 * for every server this package ships.
 *
 * Nothing here knows about stdio, HTTP or the MCP SDK. `src/transport.ts`
 * binds a runtime to an SDK server object, and the same object serves stdio
 * (agent sandboxes, M37) or streamable HTTP (the BFF's `/mcp`, M101). Keeping
 * the rules out of the transport is what makes them testable offline — and
 * what stops a second transport from arriving with a second, weaker gate.
 */
export class McpServerRuntime {
  readonly definition: ServerDefinition;

  constructor(
    definition: ServerDefinition,
    private readonly deps: ServerRuntimeDeps,
  ) {
    this.definition = defineServer(definition);
    // Runs for EVERY server, not just maestro-mcp: a gate decision must not be
    // reachable from any MCP surface (M32/M101).
    assertNoGateDecisionTools(this.definition);
  }

  get name(): string {
    return this.definition.name;
  }

  /** Every tool the server has, regardless of caller — documentation and tests. */
  allTools(): ToolListing[] {
    return this.definition.tools.map(toListing);
  }

  /**
   * What THIS caller may call. A tool their token cannot reach is not listed:
   * an agent that never sees `propose_param_change` cannot spend a turn
   * planning around it, and a listing is not a place to advertise privilege.
   * Hiding is not the control, though — `call` re-checks the scope.
   */
  listTools(rawCaller: CallerIdentity): ToolListing[] {
    const caller = sealCaller(rawCaller);
    return this.definition.tools.filter((tool) => hasScope(caller, tool.scope)).map(toListing);
  }

  async call(toolName: string, rawArgs: unknown, rawCaller: CallerIdentity): Promise<ToolCallResult> {
    // B2 — the scope set is copied and frozen before anything reads it, so the
    // decision this call makes cannot be changed by whoever still holds the
    // array the identity was built from.
    const caller = sealCaller(rawCaller);
    // Throws when the token does not belong to a corporate account — before
    // any tool runs, because an unattributable call must not happen at all.
    const actor = aiViaActor(caller);
    const tool = this.definition.tools.find((candidate) => candidate.name === toolName);

    if (tool === undefined) {
      const error = new UnknownToolError(this.definition.name, toolName);
      await this.write(actor, toolName, null, null, UNRESOLVED_SUBJECT, "denied", {
        reason: "unknown_tool",
      });
      return { status: "denied", reason: "unknown_tool", message: error.message };
    }

    if (!hasScope(caller, tool.scope)) {
      const error = new ScopeDeniedError(tool.name, tool.scope, caller.scopes);
      await this.write(actor, tool.name, tool.scope, null, UNRESOLVED_SUBJECT, "denied", {
        reason: "scope",
        required: tool.scope,
      });
      return { status: "denied", reason: "scope", message: error.message };
    }

    const parsed = tool.input.safeParse(rawArgs);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
      const error = new ToolInputError(tool.name, issues);
      await this.write(actor, tool.name, tool.scope, null, UNRESOLVED_SUBJECT, "denied", {
        reason: "invalid_input",
        // Issue paths and messages only — never the values that failed.
        issues,
      });
      return { status: "denied", reason: "invalid_input", message: error.message };
    }

    const args = parsed.data as Record<string, unknown>;
    const subject = tool.subject(args);
    const ctx = { caller, server: this.definition.name, tool: tool.name };

    // B1 — two-phase for anything that changes state. The `attempted` row goes
    // in FIRST and, if it cannot be written, the handler never runs: an effect
    // the chain cannot account for simply does not happen. A read keeps the
    // single-row form; there is no effect to strand, and doubling the chain's
    // volume for every `get_run` would cost more than it buys.
    if (tool.scope !== "read") {
      await this.write(actor, tool.name, tool.scope, null, subject, "attempted", { reason: "attempted" });
    }

    let value: unknown;
    try {
      value = await tool.handler(args, ctx);
    } catch (cause) {
      const outcome: ToolOutcome = cause instanceof ToolPolicyError ? "denied" : "error";
      await this.write(actor, tool.name, tool.scope, tool.auditAction, subject, outcome, {
        ...(cause instanceof ToolPolicyError
          ? { reason: "policy", rule: cause.rule }
          : { reason: "error" }),
      });
      if (cause instanceof ToolPolicyError) {
        return { status: "denied", reason: "policy", message: cause.message };
      }
      // Anything else is a real failure of a real system — it stays an
      // exception, so nobody reads "Jira is down" as "the tool said no".
      throw cause;
    }

    await this.write(actor, tool.name, tool.scope, tool.auditAction, subject, "ok", {});
    return { status: "ok", value };
  }

  /**
   * Writes the record.
   *
   * A refusal is recorded before the call would have run. A state-changing
   * call is BRACKETED: `attempted` before the handler, `ok`/`error` after — see
   * B1 in `src/audit.ts`. The remaining gap is the closing row of a successful
   * effect, and it is a gap that cannot be closed by ordering: the effect has
   * happened by then. It surfaces as a thrown `ToolAuditError`, loudly, to the
   * caller; the `attempted` row is already in the chain, so gap detection (M33)
   * sees an attempt with no outcome rather than nothing at all.
   */
  private async write(
    actor: string,
    tool: string,
    scope: ToolScope | null,
    action: ToolAuditRecord["action"],
    subject: string,
    outcome: ToolOutcome,
    meta: Record<string, unknown>,
  ): Promise<void> {
    const entry: ToolAuditRecord = {
      at: this.deps.now().toISOString(),
      actor,
      server: this.definition.name,
      tool,
      scope,
      subject,
      outcome,
      action,
      meta,
    };
    try {
      await this.deps.audit.record(entry);
    } catch (cause) {
      throw new ToolAuditError(tool, cause);
    }
  }
}

function toListing(tool: ToolDefinition): ToolListing {
  return {
    name: tool.name,
    description: tool.description,
    scope: tool.scope,
    input: tool.input,
  };
}
