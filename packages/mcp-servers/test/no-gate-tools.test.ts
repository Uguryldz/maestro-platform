import { describe, expect, it } from "vitest";
import { z } from "zod";
import { McpDefinitionError } from "../src/errors.js";
import {
  assertNoGateDecisionTools,
  FORBIDDEN_TOOL_NAMES,
  isGateDecisionToolName,
} from "../src/forbidden-tools.js";
import { adoMcpServer } from "../src/servers/ado.js";
import { jiraMcpServer } from "../src/servers/jira.js";
import { maestroMcpServer } from "../src/servers/maestro.js";
import { workspaceMcpServer } from "../src/servers/workspace.js";
import { defineServer, defineTool } from "../src/tool.js";
import {
  caller,
  fakeApps,
  fakeDiffs,
  fakeFs,
  fakeJiraReads,
  fakePlatform,
  fakeScm,
  fakeWork,
  runtimeFor,
} from "./helpers.js";

/**
 * M32 SoD / M101: the gate-decision tools are absent, and their absence is a
 * property of the code rather than of somebody's memory.
 */
describe("gate decisions are not an MCP capability", () => {
  const servers = () => [
    jiraMcpServer({ work: fakeWork(), reads: fakeJiraReads() }),
    adoMcpServer({ scm: fakeScm({ replies: [] }), apps: fakeApps(), diffs: fakeDiffs() }),
    workspaceMcpServer({ fs: fakeFs({ writes: [], reads: [] }) }),
    maestroMcpServer({ platform: fakePlatform({ users: [], proposalStatus: "pending_four_eyes" }) }),
  ];

  it("no server exposes approve_gate, reject_gate or merge_pr", () => {
    for (const server of servers()) {
      const names = server.tools.map((tool) => tool.name);
      for (const forbidden of FORBIDDEN_TOOL_NAMES) {
        expect(names, `${server.name} must not expose ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("maestro-mcp exposes exactly the tools M101 allows, and no others", () => {
    const server = maestroMcpServer({
      platform: fakePlatform({ users: [], proposalStatus: "pending_four_eyes" }),
    });
    // M101's three scopes, spelled out: read (workflow durumu, journal, param,
    // kota, runner sağlığı, bekleyen kapılar) · operate (workflow başlat,
    // uygulama ata, work-mode değiştir, duraklat/sürdür, adım retry, kapı
    // sahibine hatırlatma) · admin-öneri (param, kill-switch).
    expect(server.tools.map((tool) => tool.name).sort()).toEqual([
      "assign_app",
      "get_journal",
      "get_params",
      "get_repo_card",
      "get_run",
      "list_pending_gates",
      "list_runs",
      "notify_gate_owner",
      "pause_run",
      "propose_killswitch",
      "propose_param_change",
      "quota_status",
      "resume_run",
      "retry_step",
      "runner_health",
      "search_knowledge",
      "set_workmode",
      "start_workflow",
    ]);
  });

  /**
   * The mock's `V.mcp` screen showed `toggle_killswitch`. It is not here, and
   * that is the decision, not an omission: M58's switch stops the platform and
   * M101 words it "kill-switch = çift onay". A model holding a borrowed token
   * is one approval at most — and resuming after an incident, before anyone has
   * established what happened, is the more dangerous direction of the two.
   */
  it("proposes a kill-switch instead of toggling one (M58 double approval)", () => {
    const server = maestroMcpServer({
      platform: fakePlatform({ users: [], proposalStatus: "pending_four_eyes" }),
    });
    const names = server.tools.map((tool) => tool.name);

    expect(names).not.toContain("toggle_killswitch");
    expect(names).not.toContain("set_killswitch");
    const proposal = server.tools.find((tool) => tool.name === "propose_killswitch");
    expect(proposal?.scope).toBe("admin-proposal");
    // Not `KILL_SWITCH`: nothing was switched. That code belongs to the worker
    // activity that flips it, after the second human approves.
    expect(proposal?.auditAction).toBeNull();
  });

  it("gives the gate tools a read scope and a reminder, never a verdict", () => {
    const server = maestroMcpServer({
      platform: fakePlatform({ users: [], proposalStatus: "pending_four_eyes" }),
    });
    const byName = new Map(server.tools.map((tool) => [tool.name, tool]));

    expect(byName.get("list_pending_gates")?.scope).toBe("read");
    // Reminding is operate work — it sends a message — but it carries no
    // verdict and the platform method returns nothing about the gate's state.
    expect(byName.get("notify_gate_owner")?.scope).toBe("operate");
  });

  it("the full tool list of every server, seen by a caller holding every scope, has no gate decision", () => {
    const admin = caller(["read", "operate", "admin-proposal"]);
    for (const server of servers()) {
      const { runtime } = runtimeFor(server);
      for (const listing of [...runtime.allTools(), ...runtime.listTools(admin)]) {
        expect(isGateDecisionToolName(listing.name)).toBe(false);
      }
    }
  });

  it("refuses a server definition that adds one, at construction time", () => {
    const rogue = defineServer({
      name: "rogue-mcp",
      version: "0.0.1",
      description: "…",
      tools: [
        defineTool({
          name: "approve_gate",
          description: "should never exist",
          scope: "operate",
          input: z.object({ runId: z.string() }),
          subject: (args) => args.runId,
          handler: async () => ({ approved: true }),
        }),
      ],
    });
    expect(() => assertNoGateDecisionTools(rogue)).toThrow(McpDefinitionError);
    // The runtime runs the guard for every server, so the refusal is not
    // something a caller has to remember to ask for.
    expect(() => runtimeFor(rogue)).toThrow(/human channel/);
  });

  it("catches the obvious renames too", () => {
    for (const name of [
      "approve_gate",
      "approveGate",
      "gate-approve",
      "reject_gate",
      "gate_reject",
      "merge_pr",
      "mergePR",
      "pr_merge",
      "complete_pullrequest",
    ]) {
      expect(isGateDecisionToolName(name), name).toBe(true);
    }
    for (const name of ["list_runs", "get_run", "reply_thread", "notify_gate_owner", "get_journal"]) {
      expect(isGateDecisionToolName(name), name).toBe(false);
    }
  });
});
