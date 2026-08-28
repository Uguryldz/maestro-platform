import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { FORBIDDEN_TOOL_NAMES } from "../src/forbidden-tools.js";
import type { McpServerRuntime } from "../src/runtime.js";
import type { CallerIdentity } from "../src/scopes.js";
import { maestroMcpServer } from "../src/servers/maestro.js";
import { workspaceMcpServer } from "../src/servers/workspace.js";
import { bindMcpServer } from "../src/transport.js";
import { caller, fakeFs, fakePlatform, runtimeFor } from "./helpers.js";

/**
 * The transport-level proof: what a real MCP client sees over a real MCP
 * session. `InMemoryTransport` speaks the same protocol as stdio and
 * streamable HTTP, so these assertions hold for both without a socket.
 */
async function connect(runtime: McpServerRuntime, identity: CallerIdentity): Promise<Client> {
  const server = bindMcpServer(runtime, identity);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const platform = () => fakePlatform({ users: [], proposalStatus: "pending_four_eyes" });
const admin = caller(["read", "operate", "admin-proposal"]);

describe("bindMcpServer over a real MCP session", () => {
  it("publishes no gate-decision tool, even to a caller holding every scope", async () => {
    const { runtime } = runtimeFor(maestroMcpServer({ platform: platform() }));
    const client = await connect(runtime, admin);

    const names = (await client.listTools()).tools.map((tool) => tool.name);

    expect(names).toHaveLength(18);
    for (const forbidden of FORBIDDEN_TOOL_NAMES) {
      expect(names).not.toContain(forbidden);
    }
    expect(names).not.toContain("toggle_killswitch");
    await client.close();
  });

  it("publishes each tool's input schema and its scope", async () => {
    const { runtime } = runtimeFor(maestroMcpServer({ platform: platform() }));
    const client = await connect(runtime, admin);

    const tools = (await client.listTools()).tools;
    const getRun = tools.find((tool) => tool.name === "get_run");

    expect(getRun?.inputSchema).toMatchObject({ type: "object" });
    expect(getRun?.inputSchema.required).toEqual(["runId"]);
    expect(getRun?._meta).toMatchObject({ "maestro/scope": "read" });
    await client.close();
  });

  it("hides tools the connected token cannot reach", async () => {
    const { runtime } = runtimeFor(maestroMcpServer({ platform: platform() }));
    const client = await connect(runtime, caller(["read"]));

    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain("start_workflow");
    expect(names).not.toContain("propose_param_change");
    await client.close();
  });

  it("returns a result for a permitted call and audits it", async () => {
    const { runtime, audit } = runtimeFor(maestroMcpServer({ platform: platform() }));
    const client = await connect(runtime, admin);

    const result = (await client.callTool({
      name: "get_run",
      arguments: { runId: "run-ugurpay-504-0001" },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("product-owners");
    expect(audit.all()[0]).toMatchObject({ tool: "get_run", outcome: "ok", actor: "ai-via:ugur.yildiz@ugurbank.local" });
    await client.close();
  });

  it("delivers a protected-path refusal to the model as a readable tool error", async () => {
    const { runtime, audit } = runtimeFor(workspaceMcpServer({ fs: fakeFs({ writes: [], reads: [] }) }));
    const client = await connect(runtime, caller(["read", "operate"]));

    const result = (await client.callTool({
      name: "write_file",
      arguments: { path: "db/migrations/0001.sql", content: "x" },
    })) as CallToolResult;

    // A refusal must come back as a readable answer, not a dropped connection:
    // that is the only form the model can act on.
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/protected path/);
    expect(result._meta).toMatchObject({ "maestro/denialReason": "policy" });
    expect(audit.all().map((entry) => entry.outcome)).toEqual(["attempted", "denied"]);
    expect(audit.all()[1]).toMatchObject({ outcome: "denied", meta: { rule: "protected_path" } });
    await client.close();
  });
});
