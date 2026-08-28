import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { grantedScopes, TOOL_SCOPES } from "../src/scopes.js";
import { maestroMcpServer } from "../src/servers/maestro.js";
import { serverScopes } from "../src/tool.js";
import { bindMcpServer } from "../src/transport.js";
import { serveStdio, serveStreamableHttp } from "../src/transports.js";
import { caller, fakePlatform, runtimeFor } from "./helpers.js";

const platform = () => fakePlatform({ users: [], proposalStatus: "pending_four_eyes" });
const admin = caller(["read", "operate", "admin-proposal"]);

/** Newline-delimited JSON off a stream, one message at a time. */
function readMessages(stream: NodeJS.ReadableStream): { next: () => Promise<unknown> } {
  const lines = createInterface({ input: stream });
  const iterator = lines[Symbol.asyncIterator]();
  return {
    next: async (): Promise<unknown> => {
      const { value, done } = await iterator.next();
      if (done === true) throw new Error("stdio stream closed before a reply arrived");
      return JSON.parse(value as string) as unknown;
    },
  };
}

/**
 * `src/transports.ts` had never been run by anything (verifier: dead path).
 * Both factories are one line, but "one line" is exactly the shape of code
 * that is wrong in a way nobody notices: a transport that fails to attach
 * fails at the moment a real agent session starts, on a runner, with no test
 * to say which of the two it was.
 *
 * The stdio half runs a real child process speaking the real protocol; the
 * streamable-HTTP half attaches the transport the BFF drives. Neither opens a
 * socket the test has to clean up.
 */
describe("both transports actually attach (M37 stdio · M101 streamable HTTP)", () => {
  it("serves a bound server over a real stdio pipe, with the scope filter intact", async () => {
    const { runtime } = runtimeFor(maestroMcpServer({ platform: platform() }));
    const server = bindMcpServer(runtime, caller(["read"]));

    // `serveStdio` reads `process.stdin` and writes `process.stdout`, so the
    // test swaps in a pair of real pipes rather than spawning a child: the
    // transport, the framing and the JSON-RPC round trip are all the genuine
    // article, and no build step stands between the source and the assertion.
    const toServer = new PassThrough();
    const fromServer = new PassThrough();
    const realIn = process.stdin;
    const realOut = process.stdout;
    Object.defineProperty(process, "stdin", { value: toServer, configurable: true });
    Object.defineProperty(process, "stdout", { value: fromServer, configurable: true });

    let transport: Awaited<ReturnType<typeof serveStdio>>;
    try {
      transport = await serveStdio(server);
    } finally {
      Object.defineProperty(process, "stdin", { value: realIn, configurable: true });
      Object.defineProperty(process, "stdout", { value: realOut, configurable: true });
    }

    const replies = readMessages(fromServer);
    toServer.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "pipe-client", version: "0.0.1" },
        },
      })}\n`,
    );
    expect(await replies.next()).toMatchObject({ id: 1, result: { serverInfo: { name: "maestro-mcp" } } });

    toServer.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    const listed = (await replies.next()) as { result: { tools: { name: string }[] } };
    const names = listed.result.tools.map((tool) => tool.name);
    expect(names).toContain("get_run");
    // A read-only token over stdio sees no operate tool — the same rule the
    // in-memory transport enforces, proven over a real pipe.
    expect(names).not.toContain("start_workflow");

    await transport.close();
  });

  it("attaches a streamable-HTTP transport for the BFF to drive", async () => {
    const { runtime } = runtimeFor(maestroMcpServer({ platform: platform() }));
    const server = bindMcpServer(runtime, admin);

    // `sessionIdGenerator: undefined` is the stateless mode the BFF uses: it
    // owns the session store, this package owns none.
    const transport = await serveStreamableHttp(server, { sessionIdGenerator: undefined });

    expect(transport).toBeDefined();
    await transport.close();
    await server.close();
  });
});

/**
 * `grantedScopes` was exported and never called on any production path. It is
 * kept — and now exercised — because it answers a question the BFF has to ask
 * when it builds a session: which of this person's scopes does this server
 * actually offer? Answering it wrongly is how a token gets described as
 * carrying more than it can spend.
 */
describe("grantedScopes intersects, in a stable order", () => {
  it("returns only scopes the caller holds AND the server offers", () => {
    const server = maestroMcpServer({ platform: platform() });
    const offered = serverScopes(server);

    expect(grantedScopes(admin, offered).sort()).toEqual(["admin-proposal", "operate", "read"]);
    expect(grantedScopes(caller(["read"]), offered)).toEqual(["read"]);
    expect(grantedScopes(caller(["admin-proposal"]), ["read", "operate"])).toEqual([]);
    expect(grantedScopes(caller([]), offered)).toEqual([]);
  });

  it("orders by the canonical scope list, not by the caller's array", () => {
    expect(grantedScopes(caller(["admin-proposal", "read"]), [...TOOL_SCOPES])).toEqual([
      "read",
      "admin-proposal",
    ]);
  });
});
