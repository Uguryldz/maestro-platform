import { describe, expect, it } from "vitest";
import { McpDefinitionError } from "../src/errors.js";
import { adoMcpServer } from "../src/servers/ado.js";
import { jiraMcpServer } from "../src/servers/jira.js";
import { assertReadOnlyServer, defineServer, defineTool, serverScopes } from "../src/tool.js";
import { z } from "zod";
import {
  caller,
  fakeApps,
  fakeDiffs,
  fakeJiraReads,
  fakeScm,
  fakeWork,
  REPO,
  runtimeFor,
  type ScmCalls,
} from "./helpers.js";

const agent = caller(["read", "operate"]);
const jira = () => jiraMcpServer({ work: fakeWork(), reads: fakeJiraReads() });

describe("jira-mcp is read-only (M37)", () => {
  it("declares only read tools", () => {
    expect(serverScopes(jira())).toEqual(["read"]);
    expect(jira().tools.map((tool) => tool.name).sort()).toEqual([
      "get_ticket",
      "get_ticket_comments",
      "search_related_tickets",
    ]);
  });

  it("has no writing tool under any of the names a writer would take", () => {
    const names = new Set(jira().tools.map((tool) => tool.name));
    for (const writer of [
      "add_comment",
      "post_comment",
      "update_comment",
      "set_labels",
      "assign",
      "transition",
      "create_issue",
    ]) {
      expect(names.has(writer), writer).toBe(false);
    }
  });

  it("the read-only rule is enforced, not remembered", () => {
    const withWriter = defineServer({
      name: "jira-mcp",
      version: "0.0.1",
      description: "…",
      tools: [
        defineTool({
          name: "add_comment",
          description: "should never exist",
          scope: "operate",
          input: z.object({ ticketKey: z.string() }),
          subject: (args) => args.ticketKey,
          handler: async () => ({ ok: true }),
        }),
      ],
    });
    expect(() => assertReadOnlyServer(withWriter)).toThrow(McpDefinitionError);
  });

  it("reads a ticket, its comments and its neighbourhood", async () => {
    const { runtime } = runtimeFor(jira());

    const ticket = await runtime.call("get_ticket", { ticketKey: "UGURPAY-504" }, agent);
    expect(ticket).toMatchObject({ status: "ok", value: { key: "UGURPAY-504", projectKey: "UGURPAY" } });

    const comments = await runtime.call("get_ticket_comments", { ticketKey: "UGURPAY-504" }, agent);
    expect(comments.status).toBe("ok");

    const related = await runtime.call(
      "search_related_tickets",
      { ticketKey: "UGURPAY-504", text: "iade" },
      agent,
    );
    expect(related).toMatchObject({ status: "ok", value: [{ key: "UGURPAY-505", relation: "child" }] });
  });

  it("refuses a malformed ticket key before any driver is touched", async () => {
    const { runtime, audit } = runtimeFor(jira());
    const result = await runtime.call("get_ticket", { ticketKey: "not a key" }, agent);

    expect(result.status).toBe("denied");
    if (result.status === "denied") expect(result.reason).toBe("invalid_input");
    expect(audit.all()[0]?.outcome).toBe("denied");
  });
});

describe("ado-mcp reads broadly and writes exactly once", () => {
  const build = (calls: ScmCalls) =>
    adoMcpServer({ scm: fakeScm(calls), apps: fakeApps(), diffs: fakeDiffs() });

  it("only reply_thread leaves the read scope", () => {
    const server = build({ replies: [] });
    const writers = server.tools.filter((tool) => tool.scope !== "read").map((tool) => tool.name);
    expect(writers).toEqual(["reply_thread"]);
  });

  it("resolves the application to its repository before every call", async () => {
    const { runtime } = runtimeFor(build({ replies: [] }));
    const repo = await runtime.call("get_repo", { appId: "ugurpay-api" }, agent);
    expect(repo).toEqual({ status: "ok", value: REPO });
  });

  it("reads threads, status and diff", async () => {
    const { runtime } = runtimeFor(build({ replies: [] }));
    const args = { appId: "ugurpay-api", prId: 1841 };

    expect((await runtime.call("list_pr_threads", args, agent)).status).toBe("ok");
    expect((await runtime.call("get_pr_status", args, agent)).status).toBe("ok");
    expect((await runtime.call("get_pr_diff", args, agent)).status).toBe("ok");
  });

  it("replies to a review thread — the 12b loop", async () => {
    const scmCalls: ScmCalls = { replies: [] };
    const { runtime, audit } = runtimeFor(build(scmCalls));

    const result = await runtime.call(
      "reply_thread",
      { appId: "ugurpay-api", prId: 1841, threadId: 7, text: "düzeltildi" },
      agent,
    );

    expect(result).toEqual({ status: "ok", value: { replied: true, threadId: 7 } });
    expect(scmCalls.replies).toEqual([{ prId: 1841, threadId: 7, text: "düzeltildi" }]);
    expect(audit.all()[0]).toMatchObject({
      tool: "reply_thread",
      scope: "operate",
      subject: "ugurpay-api#1841/thread-7",
      actor: "ai-via:ugur.yildiz@ugurbank.local",
    });
  });

  it("refuses an empty reply rather than posting one", async () => {
    const scmCalls: ScmCalls = { replies: [] };
    const { runtime } = runtimeFor(build(scmCalls));
    const result = await runtime.call(
      "reply_thread",
      { appId: "ugurpay-api", prId: 1841, threadId: 7, text: "   " },
      agent,
    );
    expect(result.status).toBe("denied");
    expect(scmCalls.replies).toEqual([]);
  });
});
