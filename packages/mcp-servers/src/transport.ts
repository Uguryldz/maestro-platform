import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerRuntime, ToolCallResult } from "./runtime.js";
import { type CallerIdentity, sealCaller } from "./scopes.js";

/**
 * Binds a runtime to an MCP SDK server object.
 *
 * One binding, both transports. The SDK's `McpServer` is transport-agnostic:
 * the same object returned here serves an agent sandbox over stdio (M37) and
 * the BFF's `/mcp` endpoint over streamable HTTP (M101) — see
 * `src/transports.ts`. That is the whole reason the rules live in
 * `McpServerRuntime` and not in this file: a second transport must not be able
 * to arrive with a second, weaker gate.
 *
 * The binding is PER CALLER. A personal token identifies one person, the tool
 * list is filtered to what that person may call, and the audit actor is fixed
 * at bind time — so a connection cannot be re-pointed at another identity
 * halfway through a session.
 *
 * REGISTERED vs LISTED (verifier B8). Every tool the server has is registered
 * with the SDK; only the ones this caller may reach are LISTED. The binding
 * used to register the filtered set, so a call to a tool outside the caller's
 * scope died inside the SDK with `-32602 unknown tool` and produced no audit
 * row at all. What that lost is not a malformed argument — it is the record
 * that a session probed a privilege boundary, which is the most valuable
 * signal this package can hand a security team. Registration is not
 * advertisement: `runtime.call` re-checks the scope on every call and refuses,
 * audibly and in the chain, exactly as it did before.
 *
 * One honest limitation remains: the SDK validates arguments against the
 * published input schema BEFORE the callback runs, so a client that sends
 * malformed arguments to a tool it CAN see is rejected by the SDK with no
 * record. Nothing was executed and no state was touched — the MCP equivalent
 * of a malformed HTTP request.
 */
export function bindMcpServer(runtime: McpServerRuntime, rawCaller: CallerIdentity): McpServer {
  const server = new McpServer({
    name: runtime.name,
    version: runtime.definition.version,
    description: runtime.definition.description,
  });

  // B2 — the identity is copied and frozen at bind time. A connection is one
  // person for its whole life, and the scope set it was bound with cannot be
  // widened afterwards by anyone still holding the caller's array.
  const caller = sealCaller(rawCaller);

  // LISTED: only what this caller may reach, published with its real schema so
  // the model sees the same shape the runtime validates against.
  for (const tool of runtime.listTools(caller)) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.input,
        // Scope travels with the tool so a client (and a human reading a
        // session log) can see which permission each call spends.
        _meta: { "maestro/scope": tool.scope },
      },
      async (args: unknown): Promise<CallToolResult> =>
        toCallToolResult(await runtime.call(tool.name, args, caller)),
    );
  }

  // CALLABLE: everything, so that naming an out-of-scope tool is answered by
  // the runtime — with a scope refusal and an audit row — instead of dying in
  // the SDK as `-32602 unknown tool`.
  //
  // The SDK's `enabled: false` cannot do this job: a disabled tool is refused
  // at the same place with the same silence. So the `tools/call` handler is
  // replaced outright and every call goes to `runtime.call`, which has owned
  // the gate for both transports from the start.
  bindOutOfScopeCalls(server, runtime, caller);

  return server;
}

/**
 * Routes a `tools/call` for a name the SDK does not have registered — i.e. one
 * this caller cannot see — into the runtime, so the probe is refused loudly and
 * recorded (verifier B8). What is lost otherwise is not a malformed argument:
 * it is the record that a session tested a privilege boundary, which is the
 * single most valuable line this package hands a security team.
 */
function bindOutOfScopeCalls(server: McpServer, runtime: McpServerRuntime, caller: CallerIdentity): void {
  const inner = server.server;
  inner.removeRequestHandler("tools/call");
  inner.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> =>
    // Every name — listed, out of scope, or nonexistent — goes to the one
    // gate. `runtime.call` resolves the name, checks the scope, re-validates
    // the arguments against the SAME Zod schema the SDK published, and writes
    // the row, in that order. Letting the SDK serve the listed subset and the
    // runtime serve the rest would be two gates, and the weaker one would win
    // the day they disagreed.
    toCallToolResult(await runtime.call(request.params.name, request.params.arguments ?? {}, caller)),
  );
}

/**
 * A refusal is returned as `isError: true` with the reason in the text, not as
 * a transport-level failure: the model must be able to read "that path is
 * protected, a human has to make this change" and pick another route, which a
 * dropped connection would never let it do.
 */
export function toCallToolResult(result: ToolCallResult): CallToolResult {
  if (result.status === "ok") {
    return { content: [{ type: "text", text: stringify(result.value) }] };
  }
  return {
    isError: true,
    content: [{ type: "text", text: `${result.reason}: ${result.message}` }],
    _meta: { "maestro/denialReason": result.reason },
  };
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? null, null, 2);
}
