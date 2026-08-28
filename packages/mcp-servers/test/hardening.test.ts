import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { isGateDecisionToolName, normaliseToolName } from "../src/forbidden-tools.js";
import type { McpServerRuntime } from "../src/runtime.js";
import { bindMcpServer } from "../src/transport.js";
import { type CallerIdentity, sealCaller, type ToolScope } from "../src/scopes.js";
import { maestroMcpServer } from "../src/servers/maestro.js";
import { caller, fakePlatform, runtimeFor } from "./helpers.js";

const platform = () => fakePlatform({ users: [], proposalStatus: "pending_four_eyes" });

async function connect(runtime: McpServerRuntime, identity: CallerIdentity): Promise<Client> {
  const server = bindMcpServer(runtime, identity);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/**
 * B2 — `CallerIdentity.scopes` is `readonly ToolScope[]`, which is a compile-
 * time promise and nothing else: the runtime held the caller's own array by
 * reference, so anything that could still see it could `push("operate")` and
 * a bound session became an operating session mid-conversation. Whoever
 * assembles a `CallerIdentity` from a token claim (the BFF) is exactly the code
 * most likely to keep a handle on that array.
 */
describe("a bound session's scopes cannot grow underneath it (B2)", () => {
  it("decides one call against one snapshot — the array cannot change mid-call", async () => {
    const scopes: ToolScope[] = ["read"];
    const identity: CallerIdentity = { user: "ugur.yildiz@ugurbank.local", scopes };
    const { runtime } = runtimeFor(
      maestroMcpServer({
        platform: {
          ...fakePlatform({ users: [], proposalStatus: "pending_four_eyes" }),
          // A handler is the one place a caller-supplied object is reachable
          // while a decision is still in flight. Widening here must not
          // retroactively make the call legal, and must not leak into the row.
          getRun: (user) => {
            scopes.push("operate", "admin-proposal");
            return Promise.resolve({ user }) as never;
          },
        },
      }),
    );

    const result = await runtime.call("get_run", { runId: "run-ugurpay-504-0001" }, identity);

    expect(result.status).toBe("ok");
    // The push landed on the caller's own array, not on the sealed copy.
    expect(scopes).toEqual(["read", "operate", "admin-proposal"]);
  });

  it("refuses a mutation of the sealed copy outright, rather than taking it silently", () => {
    const scopes: ToolScope[] = ["read"];
    const sealed = sealCaller({ user: "ugur.yildiz@ugurbank.local", scopes });

    expect(Object.isFrozen(sealed)).toBe(true);
    expect(Object.isFrozen(sealed.scopes)).toBe(true);
    expect(() => (sealed.scopes as ToolScope[]).push("operate")).toThrow(TypeError);
    // And the copy is a copy: the original array is untouched by the seal, and
    // touching the original does not reach the seal.
    scopes.push("operate");
    expect(sealed.scopes).toEqual(["read"]);
  });

  it("keeps the MCP session's published tool list fixed at bind time", async () => {
    const scopes: ToolScope[] = ["read"];
    const identity: CallerIdentity = { user: "ugur.yildiz@ugurbank.local", scopes };
    const { runtime } = runtimeFor(maestroMcpServer({ platform: platform() }));
    const client = await connect(runtime, identity);

    scopes.push("operate", "admin-proposal");

    const result = (await client.callTool({
      name: "start_workflow",
      arguments: { ticketKey: "UGURPAY-504" },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(result._meta).toMatchObject({ "maestro/denialReason": "scope" });
    await client.close();
  });

  it("freezes the copy, so a later mutation attempt fails rather than silently taking", () => {
    const scopes: ToolScope[] = ["read"];
    const { runtime } = runtimeFor(maestroMcpServer({ platform: platform() }));
    const listed = runtime.listTools({ user: "ugur.yildiz@ugurbank.local", scopes });
    scopes.push("operate");
    expect(listed.map((tool) => tool.name)).not.toContain("start_workflow");
  });
});

/**
 * B7 — the forbidden-name net let 47 of 48 equivalent spellings through. It is
 * worth being precise about what this file IS: it is a NAME safety net, not
 * the guarantee. The guarantee that MCP cannot close a gate is structural —
 * `MaestroPlatform` has no method that decides one, and the BFF only accepts a
 * gate verdict from a human channel (`GateDecision.source`). This net exists so
 * that a future maintainer reaching for one of these names hits a boot failure
 * instead of a design discussion.
 */
describe("gate-decision names are refused in every spelling a maintainer would reach for (B7)", () => {
  const equivalents = [
    "approve_gate",
    "approveGate",
    "gate-approve",
    "reject_gate",
    "gate_reject",
    "decide_gate",
    "sign_gate",
    "gate_sign",
    "signoff_gate",
    "sign_off_gate",
    "close_gate",
    "gate_close",
    "open_gate",
    "gate_open",
    "resolve_gate",
    "gate_resolve",
    "approve_gates",
    "approve__gate",
    "APPROVE_GATE",
    "  approve_gate  ",
    "approve gate",
    "merge_pr",
    "pr_merge",
    "mergePullRequest",
    "complete_pr",
    "pr_complete",
    "close_pr",
    "abandon_pr",
    "pr_abandon",
    "set_gate_status",
    "gate_status_set",
    "set_run_status",
    "run_status_set",
    "signal_workflow",
    "workflow_signal",
    "sign_off",
    "signoff",
  ];

  for (const name of equivalents) {
    it(`refuses "${name}"`, () => {
      expect(isGateDecisionToolName(name)).toBe(true);
    });
  }

  // Unicode look-alikes: a Cyrillic "а" reads as an ASCII "a" in every review
  // tool a human uses, and normalising then rejecting non-ASCII is the only
  // way a name check survives a copy-paste from a document.
  const homoglyphs = ["аpprove_gate", "approve‐gate", "ａpprove_gate", "approve gate"];
  for (const name of homoglyphs) {
    it(`refuses the look-alike ${JSON.stringify(name)}`, () => {
      expect(isGateDecisionToolName(name)).toBe(true);
    });
  }

  it("refuses resume_gate while leaving resume_run alone", () => {
    // A net that refuses real work is a net that gets worked around, and a net
    // that gets worked around stops being consulted. `resume_run` is an M101
    // operate tool this server ships.
    expect(isGateDecisionToolName("resume_gate")).toBe(true);
    expect(isGateDecisionToolName("gate_resume")).toBe(true);
    expect(isGateDecisionToolName("resume_run")).toBe(false);
    expect(isGateDecisionToolName("pause_run")).toBe(false);
  });

  it("still allows the names the platform legitimately needs", () => {
    for (const name of [
      "list_pending_gates",
      "notify_gate_owner",
      "get_run",
      "start_workflow",
      "propose_killswitch",
      "propose_param_change",
      "set_workmode",
      "retry_step",
      "quota_status",
      "runner_health",
      "list_prs",
      "get_pr_status",
      "reply_thread",
    ]) {
      expect(isGateDecisionToolName(name), name).toBe(false);
    }
  });

  it("normalises casing, separators and width before it decides", () => {
    expect(normaliseToolName("  Approve-Gate ")).toBe("approve_gate");
    expect(normaliseToolName("APPROVE__GATE")).toBe("approve_gate");
    expect(normaliseToolName("ａpprove_gate")).toBe("approve_gate");
  });
});

/**
 * B8 — a call to a tool the caller's scope cannot reach died inside the SDK
 * with `-32602 unknown tool` and produced NO audit row, because `bindMcpServer`
 * only registered the tools the caller could see. What is lost there is not a
 * malformed argument: it is the record that somebody's session probed a
 * privilege boundary — the single most valuable line a security team gets out
 * of this package. Every tool is registered; `runtime.call` remains the gate.
 */
describe("probing a privilege boundary is recorded, not swallowed by the SDK (B8)", () => {
  it("returns a scope refusal — and an audit row — for an out-of-scope call over MCP", async () => {
    const { runtime, audit } = runtimeFor(maestroMcpServer({ platform: platform() }));
    const client = await connect(runtime, caller(["read"]));

    const result = (await client.callTool({
      name: "propose_param_change",
      arguments: { key: "gate.reminder_days", value: 5, reason: "slow" },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(result._meta).toMatchObject({ "maestro/denialReason": "scope" });
    expect(audit.all()).toHaveLength(1);
    expect(audit.all()[0]).toMatchObject({
      tool: "propose_param_change",
      outcome: "denied",
      meta: { reason: "scope", required: "admin-proposal" },
      actor: "ai-via:ugur.yildiz@ugurbank.local",
    });
    await client.close();
  });

  it("keeps listTools filtered — registration is not advertisement", async () => {
    const { runtime } = runtimeFor(maestroMcpServer({ platform: platform() }));
    const client = await connect(runtime, caller(["read"]));

    const names = (await client.listTools()).tools.map((tool) => tool.name);

    expect(names).not.toContain("propose_param_change");
    expect(names).not.toContain("start_workflow");
    expect(names).toContain("get_run");
    await client.close();
  });

  it("records the refusal for every out-of-scope tool on the server, not just one", async () => {
    const { runtime, audit } = runtimeFor(maestroMcpServer({ platform: platform() }));
    const client = await connect(runtime, caller(["read"]));

    for (const name of ["start_workflow", "assign_app", "propose_param_change", "set_workmode"]) {
      await client.callTool({ name, arguments: {} }).catch(() => undefined);
    }

    const denied = audit.all().filter((entry) => entry.outcome === "denied");
    expect(denied.map((entry) => entry.tool)).toEqual([
      "start_workflow",
      "assign_app",
      "propose_param_change",
      "set_workmode",
    ]);
    await client.close();
  });
});
