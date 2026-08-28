import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  StreamableHTTPServerTransport,
  type StreamableHTTPServerTransportOptions,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/**
 * The two transports Maestro runs, and nothing else.
 *
 * **stdio** — how an agent session reaches `jira-mcp`, `ado-mcp` and
 * `workspace-mcp` (M37). The server process lives inside the sandbox with the
 * session; there is no port, no listener and no network path into it, which is
 * the point: the runner's network profile can stay closed.
 *
 * **streamable HTTP** — how a person's IDE reaches `maestro-mcp` through the
 * BFF's `/mcp` endpoint (M101). Here there IS a network path, so the BFF
 * authenticates the personal token, resolves the caller's RBAC and only then
 * binds a runtime with `bindMcpServer(runtime, caller)`.
 *
 * Both factories are one line each on purpose. Anything that needed to differ
 * between the transports would be a rule, and rules belong in
 * `McpServerRuntime` where they are enforced for both.
 */

/** Serve a bound server over stdio; resolves once the transport is attached. */
export async function serveStdio(server: McpServer): Promise<StdioServerTransport> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return transport;
}

/**
 * A streamable-HTTP transport for the BFF to drive. The BFF owns the HTTP
 * server, the session store and the token check; this only builds the
 * transport and attaches it, so no HTTP framework leaks into this package.
 */
export async function serveStreamableHttp(
  server: McpServer,
  options?: StreamableHTTPServerTransportOptions,
): Promise<StreamableHTTPServerTransport> {
  const transport = new StreamableHTTPServerTransport(options);
  await server.connect(transport);
  return transport;
}
