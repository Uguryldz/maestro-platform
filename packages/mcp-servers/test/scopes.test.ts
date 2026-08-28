import { describe, expect, it } from "vitest";
import { grantedScopes, hasScope } from "../src/scopes.js";
import { maestroMcpServer } from "../src/servers/maestro.js";
import { workspaceMcpServer } from "../src/servers/workspace.js";
import { serverScopes } from "../src/tool.js";
import { caller, fakeFs, fakePlatform, runtimeFor } from "./helpers.js";

const platform = () => fakePlatform({ users: [], proposalStatus: "pending_four_eyes" });

describe("scope enforcement (M101)", () => {
  it("refuses an operate tool to a read-only token, and records the refusal", async () => {
    const { runtime, audit } = runtimeFor(maestroMcpServer({ platform: platform() }));
    const result = await runtime.call("start_workflow", { ticketKey: "UGURPAY-504" }, caller(["read"]));

    expect(result).toEqual({
      status: "denied",
      reason: "scope",
      message: expect.stringContaining('requires scope "operate"'),
    });
    expect(audit.all()).toHaveLength(1);
    expect(audit.all()[0]?.outcome).toBe("denied");
  });

  it("refuses an admin-proposal tool to an operate token — the scopes are a set, not a ladder", async () => {
    const { runtime } = runtimeFor(maestroMcpServer({ platform: platform() }));
    const result = await runtime.call(
      "propose_param_change",
      { key: "gate.reminder_days", value: 5, reason: "too slow" },
      caller(["read", "operate"]),
    );
    expect(result.status).toBe("denied");
    if (result.status === "denied") expect(result.reason).toBe("scope");
  });

  it("an operate token does not implicitly carry read", () => {
    const operator = caller(["operate"]);
    expect(hasScope(operator, "read")).toBe(false);
    expect(hasScope(operator, "operate")).toBe(true);
  });

  it("lists only the tools the caller's token can reach", () => {
    const { runtime } = runtimeFor(maestroMcpServer({ platform: platform() }));
    const readOnly = runtime.listTools(caller(["read"])).map((tool) => tool.name);

    expect(readOnly).toContain("get_run");
    expect(readOnly).toContain("list_pending_gates");
    expect(readOnly).toContain("quota_status");
    expect(readOnly).not.toContain("start_workflow");
    expect(readOnly).not.toContain("set_workmode");
    expect(readOnly).not.toContain("notify_gate_owner");
    expect(readOnly).not.toContain("propose_param_change");
    expect(readOnly).not.toContain("propose_killswitch");
    expect(runtime.allTools()).toHaveLength(18);
    expect(readOnly).toHaveLength(9);
  });

  it("hiding a tool is not the control — a hidden tool called directly is still refused", async () => {
    const { runtime } = runtimeFor(maestroMcpServer({ platform: platform() }));
    const readOnly = caller(["read"]);
    expect(runtime.listTools(readOnly).map((t) => t.name)).not.toContain("assign_app");

    const result = await runtime.call(
      "assign_app",
      { ticketKey: "UGURPAY-504", appId: "ugurpay-api" },
      readOnly,
    );
    expect(result.status).toBe("denied");
  });

  it("every tool declares a scope, and grantedScopes intersects rather than widens", () => {
    const server = maestroMcpServer({ platform: platform() });
    expect(serverScopes(server).sort()).toEqual(["admin-proposal", "operate", "read"]);
    // A token carrying a scope the server does not offer gains nothing.
    expect(grantedScopes(caller(["admin-proposal"]), serverScopes(server))).toEqual(["admin-proposal"]);
    expect(grantedScopes(caller(["read"]), ["operate"])).toEqual([]);
  });

  it("workspace-mcp reads are read scope; writing needs operate", async () => {
    const { runtime } = runtimeFor(workspaceMcpServer({ fs: fakeFs({ writes: [], reads: [] }) }));
    const reader = caller(["read"]);

    expect((await runtime.call("read_file", { path: "src/a.ts" }, reader)).status).toBe("ok");
    const denied = await runtime.call("write_file", { path: "src/a.ts", content: "x" }, reader);
    expect(denied.status).toBe("denied");
    if (denied.status === "denied") expect(denied.reason).toBe("scope");
  });
});
