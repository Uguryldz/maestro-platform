import { describe, expect, it } from "vitest";
import { maestroMcpServer } from "../src/servers/maestro.js";
import { caller, fakePlatform, type PlatformCalls, REPO_CARD, RUN, runtimeFor } from "./helpers.js";

const admin = caller(["read", "operate", "admin-proposal"]);
const platformCalls = (): PlatformCalls => ({ users: [], proposalStatus: "pending_four_eyes" });

describe("maestro-mcp — the platform managed with the caller's own permissions (M101)", () => {
  it("passes the calling user to the platform on every tool, so RBAC is theirs and not the AI's", async () => {
    const calls = platformCalls();
    const { runtime } = runtimeFor(maestroMcpServer({ platform: fakePlatform(calls) }));

    // Every tool the server has, not a sample of them. `actingUser` is what
    // makes "the AI holds a person's token" true rather than aspirational, and
    // a tool that forgets to pass it is a tool running with nobody's RBAC.
    const invocations: Array<[string, Record<string, unknown>]> = [
      ["list_runs", {}],
      ["get_run", { runId: RUN.runId }],
      ["get_journal", { runId: RUN.runId }],
      ["get_params", {}],
      ["get_repo_card", { appId: "ugurpay-api" }],
      ["search_knowledge", { text: "iade akışı" }],
      ["list_pending_gates", {}],
      ["quota_status", {}],
      ["runner_health", {}],
      ["start_workflow", { ticketKey: "UGURPAY-504" }],
      ["assign_app", { ticketKey: "UGURPAY-504", appId: "ugurpay-api" }],
      ["set_workmode", { runId: RUN.runId, mode: "full_auto", reason: "hızlandır" }],
      ["pause_run", { runId: RUN.runId, reason: "olay incelemesi" }],
      ["resume_run", { runId: RUN.runId, reason: "olay kapandı" }],
      ["retry_step", { runId: RUN.runId, step: "6a", reason: "geçici hata" }],
      ["notify_gate_owner", { runId: RUN.runId, step: "4" }],
      ["propose_param_change", { key: "gate.reminder_days", value: 5, reason: "slow" }],
      ["propose_killswitch", { level: "pause_intake", reason: "olay" }],
    ];

    for (const [name, args] of invocations) {
      const result = await runtime.call(name, args, admin);
      expect(result.status, name).toBe("ok");
    }

    // One acting user per tool, and it is always the human behind the token.
    expect(invocations).toHaveLength(runtime.allTools().length);
    expect(calls.users).toHaveLength(invocations.length);
    expect(new Set(calls.users)).toEqual(new Set(["ugur.yildiz@ugurbank.local"]));
  });

  it("refuses a kill-switch the platform claims to have already flipped", async () => {
    const calls: PlatformCalls = { users: [], proposalStatus: "applied" as never };
    const { runtime, audit } = runtimeFor(maestroMcpServer({ platform: fakePlatform(calls) }));

    const result = await runtime.call(
      "propose_killswitch",
      { level: "stop_all", reason: "üretimde olay" },
      admin,
    );

    expect(result.status).toBe("denied");
    if (result.status === "denied") expect(result.message).toMatch(/never flip/);
    expect(audit.all().map((entry) => entry.outcome)).toEqual(["attempted", "denied"]);
  });

  it("reads a run with the gate it is stuck on — listing a gate is allowed, closing it is not", async () => {
    const { runtime } = runtimeFor(maestroMcpServer({ platform: fakePlatform(platformCalls()) }));
    const result = await runtime.call("get_run", { runId: RUN.runId }, admin);

    expect(result).toMatchObject({
      status: "ok",
      value: { pendingGate: { step: "4", ownerGroup: "product-owners", waitingDays: 16 } },
    });
  });

  it("returns a repo card for cross-application impact (M100)", async () => {
    const { runtime } = runtimeFor(maestroMcpServer({ platform: fakePlatform(platformCalls()) }));
    expect(await runtime.call("get_repo_card", { appId: "ugurpay-api" }, admin)).toEqual({
      status: "ok",
      value: REPO_CARD,
    });
  });

  it("propose_param_change files a proposal and never reports an applied change", async () => {
    const { runtime } = runtimeFor(maestroMcpServer({ platform: fakePlatform(platformCalls()) }));
    const result = await runtime.call(
      "propose_param_change",
      { key: "gate.reminder_days", value: 5, reason: "PO 16 gündür bekliyor" },
      admin,
    );

    expect(result).toMatchObject({
      status: "ok",
      value: { status: "pending_four_eyes", approverGroup: "platform-admins" },
    });
  });

  it("refuses the result if a platform ever applies the change instead of queueing it", async () => {
    const calls: PlatformCalls = { users: [], proposalStatus: "applied" as never };
    const { runtime, audit } = runtimeFor(maestroMcpServer({ platform: fakePlatform(calls) }));

    const result = await runtime.call(
      "propose_param_change",
      { key: "gate.reminder_days", value: 5, reason: "slow" },
      admin,
    );

    expect(result.status).toBe("denied");
    if (result.status === "denied") expect(result.message).toMatch(/never apply/);
    // Bracketed (B1): the attempt is on record, and so is the refusal that
    // closed it — an auditor sees that MCP caught the bypass, not silence.
    expect(audit.all().map((entry) => entry.outcome)).toEqual(["attempted", "denied"]);
    expect(audit.all()[1]).toMatchObject({ outcome: "denied", meta: { rule: "four_eyes_bypassed" } });
  });

  it("validates identifiers against the frozen contracts before reaching the platform", async () => {
    const calls = platformCalls();
    const { runtime } = runtimeFor(maestroMcpServer({ platform: fakePlatform(calls) }));

    expect((await runtime.call("get_run", { runId: "short" }, admin)).status).toBe("denied");
    expect((await runtime.call("start_workflow", { ticketKey: "ugurpay-504" }, admin)).status).toBe("denied");
    expect((await runtime.call("assign_app", { ticketKey: "UGURPAY-504", appId: "Not An App" }, admin)).status).toBe(
      "denied",
    );
    expect(calls.users).toEqual([]);
  });

  it("caps unbounded reads instead of letting a model ask for everything", async () => {
    const { runtime } = runtimeFor(maestroMcpServer({ platform: fakePlatform(platformCalls()) }));
    expect((await runtime.call("list_runs", { limit: 5000 }, admin)).status).toBe("denied");
    expect((await runtime.call("get_journal", { runId: RUN.runId, limit: 5000 }, admin)).status).toBe("denied");
  });
});
