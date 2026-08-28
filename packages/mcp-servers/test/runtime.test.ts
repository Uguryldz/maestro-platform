import { describe, expect, it } from "vitest";
import { z } from "zod";
import { InMemoryToolAuditSink } from "../src/audit.js";
import { McpDefinitionError } from "../src/errors.js";
import { McpServerRuntime } from "../src/runtime.js";
import { defineServer, defineTool } from "../src/tool.js";
import { AT, caller, runtimeFor } from "./helpers.js";

const reader = caller(["read"]);

const serverWith = (handler: () => Promise<unknown>) =>
  defineServer({
    name: "probe-mcp",
    version: "0.0.1",
    description: "test double",
    tools: [
      defineTool({
        name: "probe",
        description: "…",
        scope: "read",
        input: z.object({ id: z.string().min(1) }),
        subject: (args) => args.id,
        handler,
      }),
    ],
  });

describe("McpServerRuntime", () => {
  it("refuses an unknown tool and still records the attempt", async () => {
    const { runtime, audit } = runtimeFor(serverWith(async () => "ok"));
    const result = await runtime.call("probe_deleted", { id: "x" }, reader);

    expect(result).toMatchObject({ status: "denied", reason: "unknown_tool" });
    expect(audit.all()[0]).toMatchObject({ tool: "probe_deleted", scope: null, subject: "(unresolved)" });
  });

  it("reports schema issues by path, without echoing the value that failed", async () => {
    const { runtime, audit } = runtimeFor(serverWith(async () => "ok"));
    const result = await runtime.call("probe", { id: "" }, reader);

    expect(result).toMatchObject({ status: "denied", reason: "invalid_input" });
    expect(JSON.stringify(audit.all()[0]?.meta)).toContain("id");
  });

  it("lets a real failure stay an exception — a broken system is not a refusal", async () => {
    const { runtime, audit } = runtimeFor(
      serverWith(() => Promise.reject(new Error("Jira DC returned 503"))),
    );

    await expect(runtime.call("probe", { id: "x" }, reader)).rejects.toThrow("503");
    expect(audit.all()[0]).toMatchObject({ outcome: "error", meta: { reason: "error" } });
  });

  it("stamps every record with the injected clock, never a wall clock", async () => {
    const { runtime, audit } = runtimeFor(serverWith(async () => "ok"));
    await runtime.call("probe", { id: "x" }, reader);
    expect(audit.all()[0]?.at).toBe(AT);
  });

  it("applies schema defaults before the handler sees the arguments", async () => {
    const seen: unknown[] = [];
    const definition = defineServer({
      name: "probe-mcp",
      version: "0.0.1",
      description: "…",
      tools: [
        defineTool({
          name: "probe",
          description: "…",
          scope: "read",
          input: z.object({ id: z.string(), limit: z.number().int().default(20) }),
          subject: (args) => args.id,
          handler: async (args) => {
            seen.push(args.limit);
            return args.limit;
          },
        }),
      ],
    });
    const { runtime } = runtimeFor(definition);
    await runtime.call("probe", { id: "x" }, reader);
    expect(seen).toEqual([20]);
  });

  it("refuses malformed definitions at construction", () => {
    expect(() =>
      defineTool({
        name: "Probe-Tool",
        description: "…",
        scope: "read",
        input: z.object({}),
        subject: () => "-",
        handler: async () => null,
      }),
    ).toThrow(McpDefinitionError);

    expect(() =>
      defineServer({ name: "empty-mcp", version: "0.0.1", description: "…", tools: [] }),
    ).toThrow(McpDefinitionError);

    const duplicated = defineTool({
      name: "probe",
      description: "…",
      scope: "read",
      input: z.object({}),
      subject: () => "-",
      handler: async () => null,
    });
    expect(() =>
      new McpServerRuntime(
        { name: "dup-mcp", version: "0.0.1", description: "…", tools: [duplicated, duplicated] },
        { audit: new InMemoryToolAuditSink(), now: () => new Date(AT) },
      ),
    ).toThrow(/duplicate tool/);
  });
});
