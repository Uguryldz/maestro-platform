import type { AgentSessionOptions, LlmOutcome, LlmPort } from "@maestro/ports";
import { describe, expect, it } from "vitest";
import { MSG_BLOCKED_CONFIDENTIAL, MSG_DEGRADED_AI_ASSIST, WINDOW_MS } from "../src/index.js";
import { ANSWER, Analysis, anthropicBody, build, request } from "./gateway-fixture.js";
import { stubRunner } from "./helpers.js";

/**
 * B9 regression (M18/M55/M97). The port used to hand `queued`, `degrade` and
 * `block` back as exceptions, and `degrade_ai_assist` vs `block` could only be
 * told apart by comparing a message-key STRING. They are different instructions
 * — "continue human-led" vs "stop and wait for compliance" — so they are now
 * different `status` values the caller must switch on.
 */

/** What a Wave 3 workflow does with each state; the switch is exhaustive by design. */
type Action = "use_result" | "start_timer" | "fall_back_to_ai_assist" | "halt_the_run";

function decide<T>(outcome: LlmOutcome<T>): Action {
  switch (outcome.status) {
    case "ok":
      return "use_result";
    case "queued":
      return "start_timer";
    case "degraded":
      return "fall_back_to_ai_assist";
    case "blocked":
      return "halt_the_run";
    default: {
      // Adding a state to `LlmOutcome` breaks compilation here, not at runtime.
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}

const confidential = { ...request, dataClass: "gizli" } as const;

const agentOpts: AgentSessionOptions = {
  workspacePath: "/work/UGURPAY-1",
  task: "implement the change",
  mcpServers: ["maestro-mcp"],
  dataClass: "dahili",
  variantId: "backend",
};

describe("every LlmOutcome branch is reachable through the port (M18/M55)", () => {
  it("ok: the call happened and the value is schema-valid", async () => {
    const { gateway } = build();
    const outcome = await gateway.generateObject(request, Analysis);

    expect(decide(outcome)).toBe("use_result");
    if (outcome.status !== "ok") return expect.unreachable("expected an ok outcome");
    expect(outcome.value.risk).toBe("orta");
    expect(outcome.log.driver).toBe("claude-sub");
  });

  it("queued: the pool is exhausted, so the caller waits until resumeAt", async () => {
    const { gateway } = build({}, {}, [{ body: anthropicBody(ANSWER) }]);
    await gateway.generateObject(request, Analysis);

    const outcome = await gateway.generateObject(request, Analysis);
    expect(decide(outcome)).toBe("start_timer");
    if (outcome.status !== "queued") return expect.unreachable("expected a queued outcome");
    expect(outcome.reason).toBe("subscription_quota");
    // An ISO datetime, so a Temporal timer can be built from it directly.
    expect(Date.parse(outcome.resumeAt)).toBe(Date.parse("2026-08-08T09:00:00.000Z") + WINDOW_MS["5h"]);
  });

  it("degraded: no backend may see the class, so the flow continues human-led (M97)", async () => {
    const { gateway, stub } = build();
    const outcome = await gateway.generateObject(confidential, Analysis);

    expect(decide(outcome)).toBe("fall_back_to_ai_assist");
    expect(outcome).toEqual({ status: "degraded", dataClass: "gizli", messageKey: MSG_DEGRADED_AI_ASSIST });
    expect(stub.calls).toHaveLength(0);
  });

  it("blocked: policy forbids the call, so the flow stops", async () => {
    const { gateway, stub } = build({ onPremMissing: "block" });
    const outcome = await gateway.generateObject(confidential, Analysis);

    expect(decide(outcome)).toBe("halt_the_run");
    expect(outcome).toEqual({ status: "blocked", dataClass: "gizli", messageKey: MSG_BLOCKED_CONFIDENTIAL });
    expect(stub.calls).toHaveLength(0);
  });
});

describe("degraded and blocked are distinguishable without reading a message key (B9)", () => {
  it("splits one identical request into two different instructions", async () => {
    // Same request, same bindings, same routes: only the compliance team's
    // `onPremMissing` choice differs. The old port collapsed both of these into
    // one `LlmPolicyBlockedError`, so a workflow could not tell them apart.
    const degrading = await build({ onPremMissing: "degrade_ai_assist" }).gateway.generateObject(
      confidential,
      Analysis,
    );
    const blocking = await build({ onPremMissing: "block" }).gateway.generateObject(confidential, Analysis);

    expect(degrading.status).toBe("degraded");
    expect(blocking.status).toBe("blocked");
    expect(decide(degrading)).not.toBe(decide(blocking));
  });

  it("splits an agent turn the same way, through the LlmPort type itself", async () => {
    const agentRunner = stubRunner([]);
    const degrading: LlmPort = build({ onPremMissing: "degrade_ai_assist" }, { agentRunner }, []).gateway;
    const blocking: LlmPort = build({ onPremMissing: "block" }, { agentRunner }, []).gateway;

    const gizli = { ...agentOpts, dataClass: "gizli" } as const;
    expect(decide(await degrading.agentSession(gizli))).toBe("fall_back_to_ai_assist");
    expect(decide(await blocking.agentSession(gizli))).toBe("halt_the_run");
    expect(agentRunner.inputs).toHaveLength(0);
  });
});

describe("real failures stay exceptions, they are not outcomes", () => {
  it("does not turn a provider error or a schema miss into a status", async () => {
    const { gateway } = build({}, {}, [{ status: 400, body: { error: "bad model" } }]);
    await expect(gateway.generateObject(request, Analysis)).rejects.toThrow(/HTTP 400/);

    const bad = build({}, {}, [{ body: anthropicBody("prose, not json") }, { body: anthropicBody("still prose") }]);
    await expect(bad.gateway.generateObject(request, Analysis)).rejects.toThrow(/schema "Analysis"/);
  });
});
