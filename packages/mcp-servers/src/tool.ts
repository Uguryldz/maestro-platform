import type { AuditAction } from "@maestro/contracts";
import type { z } from "zod";
import { McpDefinitionError } from "./errors.js";
import type { CallerIdentity, ToolScope } from "./scopes.js";

/** What a handler is told about the call it is serving. */
export interface ToolCallContext {
  readonly caller: CallerIdentity;
  readonly server: string;
  readonly tool: string;
}

type Args = Record<string, unknown>;

/**
 * One MCP tool. The schema is a Zod object because the transport publishes its
 * shape to the model AND the runtime re-validates against it before a handler
 * ever runs — the same schema on both sides, so a client that ignores the
 * published shape gains nothing.
 */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly scope: ToolScope;
  readonly input: z.ZodObject<z.ZodRawShape>;
  /**
   * The frozen `AuditAction` (contracts, M33) this call maps onto, or `null`
   * when none of them describes it honestly. `null` is not "unaudited": the
   * record is still written, it just carries no SIEM action code. See
   * `src/audit.ts` and the interface request in RAPOR.md.
   */
  readonly auditAction: AuditAction | null;
  /** Audit subject, derived from validated arguments (ticket key, run id, path…). */
  readonly subject: (args: Args) => string;
  readonly handler: (args: Args, ctx: ToolCallContext) => Promise<unknown>;
}

/** MCP tool names are snake_case; the transport and the audit trail key on them. */
const TOOL_NAME = /^[a-z][a-z0-9_]{2,63}$/;

export interface ToolSpec<Shape extends z.ZodRawShape> {
  readonly name: string;
  readonly description: string;
  readonly scope: ToolScope;
  readonly input: z.ZodObject<Shape>;
  readonly auditAction?: AuditAction;
  readonly subject: (args: z.output<z.ZodObject<Shape>>) => string;
  readonly handler: (args: z.output<z.ZodObject<Shape>>, ctx: ToolCallContext) => Promise<unknown>;
}

/**
 * Typed at the definition site, erased in the collection. The single cast lives
 * here so no server file has to write one — and so `subject`/`handler` can
 * never be wired to a schema they do not match.
 */
export function defineTool<Shape extends z.ZodRawShape>(spec: ToolSpec<Shape>): ToolDefinition {
  if (!TOOL_NAME.test(spec.name)) {
    throw new McpDefinitionError(`tool name "${spec.name}" is not snake_case [a-z0-9_], 3-64 chars`);
  }
  return {
    name: spec.name,
    description: spec.description,
    scope: spec.scope,
    input: spec.input as unknown as z.ZodObject<z.ZodRawShape>,
    auditAction: spec.auditAction ?? null,
    subject: spec.subject as (args: Args) => string,
    handler: spec.handler as (args: Args, ctx: ToolCallContext) => Promise<unknown>,
  };
}

export interface ServerDefinition {
  /** MCP server name as agents and IDEs reference it: `jira-mcp`, `maestro-mcp`. */
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly tools: readonly ToolDefinition[];
}

export function defineServer(definition: ServerDefinition): ServerDefinition {
  const seen = new Set<string>();
  for (const tool of definition.tools) {
    if (seen.has(tool.name)) {
      throw new McpDefinitionError(`${definition.name}: duplicate tool "${tool.name}"`);
    }
    seen.add(tool.name);
  }
  if (definition.tools.length === 0) {
    throw new McpDefinitionError(`${definition.name}: a server with no tools is a wiring bug`);
  }
  return definition;
}

/** Scopes actually used by a server's tools. */
export function serverScopes(definition: ServerDefinition): ToolScope[] {
  return [...new Set(definition.tools.map((tool) => tool.scope))];
}

/**
 * Structural guard for the read-only servers (M37): the agent reads Jira, it
 * never writes to it — writing to a ticket is a workflow activity, run by the
 * worker under its own identity, so that "the AI said it" and "the platform
 * said it" stay different sentences in the ticket history.
 */
export function assertReadOnlyServer(definition: ServerDefinition): void {
  const writers = definition.tools.filter((tool) => tool.scope !== "read");
  if (writers.length > 0) {
    throw new McpDefinitionError(
      `${definition.name} must expose read tools only; found: ${writers.map((t) => t.name).join(", ")}`,
    );
  }
}
