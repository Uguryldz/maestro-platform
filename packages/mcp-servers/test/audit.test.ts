import { parseActor } from "@maestro/audit";
import { describe, expect, it } from "vitest";
import { aiViaActor, type ToolAuditRecord, type ToolAuditSink } from "../src/audit.js";
import { McpDefinitionError, ToolAuditError } from "../src/errors.js";
import { McpServerRuntime } from "../src/runtime.js";
import { maestroMcpServer } from "../src/servers/maestro.js";
import { workspaceMcpServer } from "../src/servers/workspace.js";
import { AT, caller, fakeFs, fakePlatform, runtimeFor } from "./helpers.js";

const platform = () => fakePlatform({ users: [], proposalStatus: "pending_four_eyes" });
const admin = caller(["read", "operate", "admin-proposal"]);

describe("every tool call reaches the audit chain as ai-via:<user> (M101)", () => {
  it("records an ok call with the delegating human visible", async () => {
    const { runtime, audit } = runtimeFor(maestroMcpServer({ platform: platform() }));
    await runtime.call("get_run", { runId: "run-ugurpay-504-0001" }, admin);

    const [entry] = audit.all();
    expect(entry).toMatchObject({
      at: AT,
      actor: "ai-via:ugur.yildiz@ugurbank.local",
      server: "maestro-mcp",
      tool: "get_run",
      scope: "read",
      subject: "run-ugurpay-504-0001",
      outcome: "ok",
      action: null,
    });
    // The audit package must accept what this package mints, and must see the
    // human behind the delegation.
    expect(parseActor(entry?.actor ?? "")).toEqual({
      kind: "ai_delegated",
      user: "ugur.yildiz@ugurbank.local",
    });
  });

  it("records the four outcome shapes: ok, unknown tool, scope refusal, policy refusal", async () => {
    const { runtime, audit } = runtimeFor(workspaceMcpServer({ fs: fakeFs({ writes: [], reads: [] }) }));

    await runtime.call("read_file", { path: "src/a.ts" }, admin);
    await runtime.call("delete_everything", {}, admin);
    await runtime.call("write_file", { path: "src/a.ts", content: "x" }, caller(["read"]));
    await runtime.call("write_file", { path: "db/migrations/0001.sql", content: "x" }, admin);

    // Four calls, five rows: the protected-path write is the only one that got
    // as far as the handler, so it is the only one bracketed (B1).
    expect(audit.all().map((entry) => [entry.tool, entry.outcome])).toEqual([
      ["read_file", "ok"],
      ["delete_everything", "denied"],
      ["write_file", "denied"],
      ["write_file", "attempted"],
      ["write_file", "denied"],
    ]);
    expect(audit.all().every((entry) => entry.actor.startsWith("ai-via:"))).toBe(true);
    expect(audit.all()[1]?.scope).toBeNull();
    expect(audit.all()[4]?.meta).toMatchObject({ reason: "policy", rule: "protected_path" });
  });

  it("maps only the calls a frozen AuditAction describes truthfully", async () => {
    const { runtime, audit } = runtimeFor(maestroMcpServer({ platform: platform() }));

    await runtime.call("start_workflow", { ticketKey: "UGURPAY-504" }, admin);
    await runtime.call("assign_app", { ticketKey: "UGURPAY-504", appId: "ugurpay-api" }, admin);
    await runtime.call(
      "propose_param_change",
      { key: "gate.reminder_days", value: 5, reason: "slow" },
      admin,
    );

    // The action code goes on the row that says the thing HAPPENED, never on
    // the `attempted` row that says it is about to be tried (B1).
    expect(audit.all().map((entry) => [entry.outcome, entry.action])).toEqual([
      ["attempted", null],
      ["ok", "RUN_STARTED"],
      ["attempted", null],
      ["ok", "ASSIGN_APP"],
      ["attempted", null],
      // A proposal is not a change; claiming PARAM_CHANGED here would be the
      // most misleading row in the chain.
      ["ok", null],
    ]);
  });

  it("keeps raw arguments out of the record", async () => {
    const { runtime, audit } = runtimeFor(maestroMcpServer({ platform: platform() }));
    await runtime.call(
      "search_knowledge",
      { text: "müşteri TR33 0006 1005 1978 6457 8413 26 iade etti" },
      admin,
    );

    const entry = audit.all()[0];
    expect(entry?.subject).toBe("(knowledge)");
    expect(JSON.stringify(entry)).not.toContain("6457");
  });

  it("a call that cannot be recorded is a failed call, not a quiet success", async () => {
    const failing: ToolAuditSink = {
      record: (_entry: ToolAuditRecord) => Promise.reject(new Error("chain unavailable")),
    };
    const runtime = new McpServerRuntime(maestroMcpServer({ platform: platform() }), {
      audit: failing,
      now: () => new Date(AT),
    });
    await expect(runtime.call("get_run", { runId: "run-ugurpay-504-0001" }, admin)).rejects.toThrow(
      ToolAuditError,
    );
  });

  it("refuses a token that does not belong to a corporate account", async () => {
    const { runtime, audit } = runtimeFor(maestroMcpServer({ platform: platform() }));
    await expect(
      runtime.call("get_run", { runId: "run-ugurpay-504-0001" }, caller(["read"], "service-bot")),
    ).rejects.toThrow(McpDefinitionError);
    expect(audit.all()).toHaveLength(0);
  });

  it("aiViaActor produces exactly the actor form the audit chain accepts", () => {
    expect(aiViaActor(caller(["read"]))).toBe("ai-via:ugur.yildiz@ugurbank.local");
    expect(() => aiViaActor(caller(["read"], "maestro-worker"))).toThrow(McpDefinitionError);
  });
});
