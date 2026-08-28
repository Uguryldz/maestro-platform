import type { AgentSessionOptions } from "@maestro/ports";
import { describe, expect, it } from "vitest";
import { AgentRunnerNotWiredError } from "../src/index.js";
import { build } from "./gateway-fixture.js";
import { stubRunner } from "./helpers.js";

/** The data class and the variant are the CALLER's, never a gateway default (M18/M38). */
const opts: AgentSessionOptions = {
  workspacePath: "/work/UGURPAY-1",
  task: "implement the change",
  mcpServers: ["maestro-mcp"],
  dataClass: "dahili",
  variantId: "backend",
};

const DONE = [{ finalText: "done", tokensIn: 10, tokensOut: 3, vendorSessionId: "v1" }];

describe("LlmGateway.agentSession (M17 delegation)", () => {
  it("picks the backend, opens a session and delegates the run", async () => {
    const agentRunner = stubRunner(DONE);
    const { gateway, stub } = build({}, { agentRunner }, []);

    const outcome = await gateway.agentSession(opts);

    if (outcome.status !== "ok") return expect.unreachable("expected an ok outcome");
    expect(outcome.value.resumeToken).toBe("session-1");
    expect(outcome.value.finalText).toBe("done");
    expect(outcome.log).toMatchObject({
      role: "engineer",
      variantId: "backend",
      dataClass: "dahili",
      driver: "claude-sub",
      model: "claude-sonnet",
      usd: null,
    });
    // The result carries the same log row, so a resumed turn can be logged alone.
    expect(outcome.value.log).toBe(outcome.log);
    expect(agentRunner.inputs[0]).toEqual({
      driver: "claude-sub",
      model: "claude-sonnet",
      workspacePath: "/work/UGURPAY-1",
      task: "implement the change",
      mcpServers: ["maestro-mcp"],
      vendorSessionId: null,
      credentialRef: "llm/seat1",
    });
    // The gateway itself makes no provider call — execution is Wave 2's job.
    expect(stub.calls).toHaveLength(0);
  });

  it("resumes the same session and hands the vendor handle back", async () => {
    const agentRunner = stubRunner([
      { finalText: "turn 1", tokensIn: 10, tokensOut: 3, vendorSessionId: "v1" },
      { finalText: "turn 2", tokensIn: 5, tokensOut: 2 },
    ]);
    const { gateway } = build(
      {
        subscriptionPool: {
          accounts: [
            {
              accountId: "sub-1",
              driver: "claude-sub",
              transport: "anthropic-direct",
              credentialRef: "llm/seat1",
              windows: [{ kind: "5h", costPctPerCall: 1 }],
            },
          ],
        },
      },
      { agentRunner },
      [],
    );

    const first = await gateway.agentSession(opts);
    if (first.status !== "ok") return expect.unreachable("expected an ok outcome");
    const second = await gateway.agentSession({ ...opts, resumeToken: first.value.resumeToken });

    if (second.status !== "ok") return expect.unreachable("expected an ok outcome");
    expect(second.value.resumeToken).toBe(first.value.resumeToken);
    expect(agentRunner.inputs[1]?.vendorSessionId).toBe("v1");
    expect(second.value.finalText).toBe("turn 2");
  });

  it("queues an agent turn when the pool is exhausted, without calling the runner", async () => {
    const agentRunner = stubRunner(DONE);
    const { gateway } = build({}, { agentRunner }, []);
    await gateway.agentSession(opts);

    const queued = await gateway.agentSession(opts);
    expect(queued).toMatchObject({ status: "queued", reason: "subscription_quota" });
    expect(agentRunner.inputs).toHaveLength(1);
  });

  it("refuses to run when no agent runner is wired", async () => {
    const { gateway } = build({}, {}, []);
    await expect(gateway.agentSession(opts)).rejects.toBeInstanceOf(AgentRunnerNotWiredError);
  });

  it("degrades an agent turn when the caller's data class has no backend", async () => {
    const agentRunner = stubRunner(DONE);
    const { gateway } = build({}, { agentRunner }, []);

    expect(await gateway.agentSession({ ...opts, dataClass: "gizli" })).toMatchObject({
      status: "degraded",
      dataClass: "gizli",
    });
    expect(agentRunner.inputs).toHaveLength(0);
  });
});
