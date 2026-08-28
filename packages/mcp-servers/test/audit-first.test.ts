import { describe, expect, it } from "vitest";
import type { ToolAuditRecord, ToolAuditSink } from "../src/audit.js";
import { ToolAuditError } from "../src/errors.js";
import { McpServerRuntime } from "../src/runtime.js";
import { maestroMcpServer } from "../src/servers/maestro.js";
import { workspaceMcpServer } from "../src/servers/workspace.js";
import { AT, caller, fakePlatform, type PlatformCalls } from "./helpers.js";

const admin = caller(["read", "operate", "admin-proposal"]);

/** A sink that fails on the Nth write and records everything it was handed. */
function flakySink(failOn: (entry: ToolAuditRecord, index: number) => boolean): {
  sink: ToolAuditSink;
  seen: ToolAuditRecord[];
} {
  const seen: ToolAuditRecord[] = [];
  let index = 0;
  return {
    seen,
    sink: {
      record(entry: ToolAuditRecord): Promise<void> {
        const i = index;
        index += 1;
        seen.push(entry);
        return failOn(entry, i) ? Promise.reject(new Error("chain unavailable")) : Promise.resolve();
      },
    },
  };
}

function runtimeWith(sink: ToolAuditSink, definition = maestroMcpServer({ platform: fakePlatform(calls()) })) {
  return new McpServerRuntime(definition, { audit: sink, now: () => new Date(AT) });
}

function calls(): PlatformCalls {
  return { users: [], proposalStatus: "pending_four_eyes" };
}

/**
 * B1 — the audit write used to happen AFTER the handler, so a sink that was
 * down let the effect land and then threw. The call "failed"; the work did
 * not. M101's whole claim is that a conversation with an AI leaves the same
 * trail as a click in Studio, and an effect with no row is exactly the event
 * an auditor can never reconstruct.
 *
 * The fix is two-phase for anything that changes state: an `attempted` row
 * first — and if THAT write fails the handler never runs — then an `ok` or
 * `error` row to close it. Reads keep the old single-row ordering: a read has
 * no effect to strand, and doubling the chain's volume for every `get_run`
 * would cost the chain more than it buys.
 */
describe("an effect is never allowed to outrun its audit row (B1)", () => {
  it("does not start a workflow when the attempt cannot be recorded", async () => {
    const platformCalls = calls();
    const { sink, seen } = flakySink((_entry, i) => i === 0);
    const runtime = runtimeWith(sink, maestroMcpServer({ platform: fakePlatform(platformCalls) }));

    await expect(runtime.call("start_workflow", { ticketKey: "UGURPAY-504" }, admin)).rejects.toThrow(
      ToolAuditError,
    );

    // The platform was never reached: no run exists that the chain does not know about.
    expect(platformCalls.users).toEqual([]);
    expect(seen.map((entry) => entry.outcome)).toEqual(["attempted"]);
  });

  it("does not write a file when the attempt cannot be recorded", async () => {
    const writes: { path: string; content: string }[] = [];
    const { sink } = flakySink((_entry, i) => i === 0);
    const runtime = runtimeWith(
      sink,
      workspaceMcpServer({
        fs: {
          readFile: () => Promise.resolve({ path: "x", content: "", bytes: 0, truncated: false }),
          writeFile: (path, content) => {
            writes.push({ path, content });
            return Promise.resolve({ bytes: content.length });
          },
          listDir: () => Promise.resolve([]),
          search: () => Promise.resolve([]),
        },
      }),
    );

    await expect(
      runtime.call("write_file", { path: "src/a.ts", content: "x" }, caller(["operate"])),
    ).rejects.toThrow(ToolAuditError);
    expect(writes).toEqual([]);
  });

  it("does not file a param proposal when the attempt cannot be recorded", async () => {
    const platformCalls = calls();
    const { sink } = flakySink((_entry, i) => i === 0);
    const runtime = runtimeWith(sink, maestroMcpServer({ platform: fakePlatform(platformCalls) }));

    await expect(
      runtime.call("propose_param_change", { key: "gate.reminder_days", value: 5, reason: "slow" }, admin),
    ).rejects.toThrow(ToolAuditError);
    expect(platformCalls.users).toEqual([]);
  });

  it("brackets a successful effect with attempted → ok, both naming the same subject", async () => {
    const { sink, seen } = flakySink(() => false);
    const runtime = runtimeWith(sink);

    const result = await runtime.call("start_workflow", { ticketKey: "UGURPAY-504" }, admin);

    expect(result.status).toBe("ok");
    expect(seen.map((entry) => entry.outcome)).toEqual(["attempted", "ok"]);
    expect(seen.every((entry) => entry.subject === "UGURPAY-504")).toBe(true);
    expect(seen.every((entry) => entry.tool === "start_workflow")).toBe(true);
    // The action code belongs on the row that says the thing happened.
    expect(seen[0]?.action).toBeNull();
    expect(seen[1]?.action).toBe("RUN_STARTED");
  });

  it("closes a failed effect with an error row rather than leaving the attempt dangling", async () => {
    const { sink, seen } = flakySink(() => false);
    const runtime = runtimeWith(
      sink,
      maestroMcpServer({
        platform: {
          ...fakePlatform(calls()),
          startWorkflow: () => Promise.reject(new Error("Temporal is down")),
        },
      }),
    );

    await expect(runtime.call("start_workflow", { ticketKey: "UGURPAY-504" }, admin)).rejects.toThrow(
      /Temporal is down/,
    );
    expect(seen.map((entry) => entry.outcome)).toEqual(["attempted", "error"]);
  });

  it("still surfaces a closing-row failure loudly, so the gap is never silent", async () => {
    const platformCalls = calls();
    // First row lands, second (the `ok`) does not: the effect happened and the
    // chain is short a row. That must reach the caller as a thrown error.
    const { sink, seen } = flakySink((_entry, i) => i === 1);
    const runtime = runtimeWith(sink, maestroMcpServer({ platform: fakePlatform(platformCalls) }));

    await expect(runtime.call("start_workflow", { ticketKey: "UGURPAY-504" }, admin)).rejects.toThrow(
      ToolAuditError,
    );
    expect(platformCalls.users).toHaveLength(1);
    expect(seen.map((entry) => entry.outcome)).toEqual(["attempted", "ok"]);
  });

  it("leaves reads on one row — a read has no effect to strand", async () => {
    const { sink, seen } = flakySink(() => false);
    const runtime = runtimeWith(sink);

    await runtime.call("get_run", { runId: "run-ugurpay-504-0001" }, admin);

    expect(seen.map((entry) => entry.outcome)).toEqual(["ok"]);
  });

  it("writes no attempted row for a call that never got past the gate", async () => {
    const { sink, seen } = flakySink(() => false);
    const runtime = runtimeWith(sink);

    // Scope refusal, schema refusal, unknown tool: nothing was attempted, so
    // there is nothing to bracket.
    await runtime.call("start_workflow", { ticketKey: "UGURPAY-504" }, caller(["read"]));
    await runtime.call("start_workflow", { ticketKey: "not a key" }, admin);
    await runtime.call("delete_everything", {}, admin);

    expect(seen.map((entry) => entry.outcome)).toEqual(["denied", "denied", "denied"]);
  });
});
