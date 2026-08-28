import type { AgentSessionOptions } from "@maestro/ports";
import { describe, expect, it } from "vitest";
import {
  LlmGateway,
  MSG_BLOCKED_ROUTE,
  SessionPolicyChangedError,
  parseGatewayConfig,
  type LlmGatewayConfig,
} from "../src/index.js";
import { SAMPLE_IBAN, fakeClock, gatewayDeps, piiMask, stubFetch, stubRunner } from "./helpers.js";

/**
 * B2/B3/B4 regressions. An agent session is a multi-turn conversation, and every
 * one of its turns is an egress: masking must survive the resume (M20/M54), the
 * policy must be asked again on every turn so a narrowed route or a kill-switch
 * reaches sessions that are already open (M58), and the class a turn is routed
 * with is the one the CALLER handed in — the gateway has no default to fall back
 * to any more (B4 closed permanently).
 */

const cloudDriver = { driver: "anthropic-direct", apiKeyRef: "llm/anthropic" };
const onPremDriver = { driver: "openai-compat", baseUrl: "https://vllm.internal.bank", apiKeyRef: "llm/vllm", onPrem: true };

const raw = {
  drivers: [cloudDriver, onPremDriver],
  bindings: [
    { role: "engineer", driver: "anthropic-direct", model: "claude-cloud" },
    { role: "engineer", driver: "openai-compat", model: "qwen-onprem" },
  ],
  routes: [
    { dataClass: "acik", allowedDrivers: ["anthropic-direct", "openai-compat"] },
    { dataClass: "dahili", allowedDrivers: ["anthropic-direct", "openai-compat"] },
    { dataClass: "gizli", allowedDrivers: ["anthropic-direct", "openai-compat"] },
  ],
};

const opts: AgentSessionOptions = {
  workspacePath: "/work/UGURPAY-1",
  task: `fix the CI break on ${SAMPLE_IBAN}`,
  mcpServers: ["maestro-mcp"],
  dataClass: "dahili",
  variantId: "backend",
};

function build(over: Record<string, unknown>, outputs = [turn("turn 1"), turn("turn 2")]) {
  const cfg: LlmGatewayConfig = parseGatewayConfig({ ...raw, ...over });
  const runner = stubRunner(outputs);
  const deps = gatewayDeps(stubFetch([]), fakeClock(), { agentRunner: runner, mask: piiMask() });
  // The parsed config object is the one the gateway reads on every turn, so a
  // compliance edit / kill-switch is simulated by editing it in place.
  return { cfg, runner, gateway: new LlmGateway(cfg, deps) };
}

function turn(finalText: string) {
  return { finalText, tokensIn: 10, tokensOut: 3, vendorSessionId: "v1" };
}

function gizli(dataClass: string, allowed: string[]) {
  return raw.routes.map((r) => (r.dataClass === dataClass ? { ...r, allowedDrivers: allowed } : r));
}

/** Every suite here is about turns that DID open, so ok is the precondition. */
async function openSession(gateway: LlmGateway, over: Partial<typeof opts> = {}): Promise<string> {
  const outcome = await gateway.agentSession({ ...opts, ...over });
  if (outcome.status !== "ok") throw new Error(`expected an ok outcome, got "${outcome.status}"`);
  return outcome.value.resumeToken;
}

describe("agent session masking survives the resume (B2 · M20/M54)", () => {
  it("masks the second turn exactly like the first", async () => {
    const { gateway, runner } = build({
      onPremMissing: "masked_cloud",
      routes: gizli("gizli", ["anthropic-direct"]),
    });

    const resumeToken = await openSession(gateway, { dataClass: "gizli" });
    await gateway.agentSession({ ...opts, dataClass: "gizli", resumeToken, task: `retry after ${SAMPLE_IBAN}` });

    expect(runner.inputs).toHaveLength(2);
    for (const input of runner.inputs) {
      // Tokens carry a per-session nonce ("[IBAN_1.a3f9]") since @maestro/pii's
      // B-8 fix, so the assertion matches the prefix rather than the whole token.
      expect(input.task).toContain("[IBAN_1.");
      expect(input.task).not.toContain(SAMPLE_IBAN);
    }
  });

  it("hands back an unmask for the human-facing text only (M20)", async () => {
    const { gateway, runner } = build(
      { onPremMissing: "masked_cloud", routes: gizli("gizli", ["anthropic-direct"]) },
      [turn(`done with [IBAN_1]`)],
    );

    const outcome = await gateway.agentSession({ ...opts, dataClass: "gizli" });
    if (outcome.status !== "ok") return expect.unreachable("expected an ok outcome");
    // What may be persisted stays masked; the reveal is an explicit call. The
    // token the model was actually given carries this session's nonce.
    const token = /\[IBAN_1\.[0-9a-f]+\]/.exec(runner.inputs[0]?.task ?? "")?.[0] ?? "";
    expect(outcome.value.finalText).toBe("done with [IBAN_1]");
    expect(outcome.unmask?.(`done with ${token}`)).toBe(`done with ${SAMPLE_IBAN}`);
  });
});

describe("every agent turn is re-checked against the policy (B3 · M58)", () => {
  it("blocks a resume whose route no longer permits any backend", async () => {
    const { cfg, gateway, runner } = build({});
    const resumeToken = await openSession(gateway);

    // Compliance narrows the class to a backend this role has no binding for.
    cfg.routes = gizli("dahili", ["aws-bedrock"]) as LlmGatewayConfig["routes"];

    // A `dahili` block says so: the confidential key would misreport the class.
    expect(await gateway.agentSession({ ...opts, resumeToken })).toEqual({
      status: "blocked",
      dataClass: "dahili",
      messageKey: MSG_BLOCKED_ROUTE,
    });
    expect(runner.inputs).toHaveLength(1);
  });

  it("refuses a resume that would contradict the session's pinned backend", async () => {
    const { cfg, gateway, runner } = build({});
    const resumeToken = await openSession(gateway);
    expect(runner.inputs[0]?.driver).toBe("anthropic-direct");

    // Kill-switch on the cloud lane: the policy now resolves to on-prem, but the
    // session is pinned to the cloud driver. Neither answer is safe — refuse.
    cfg.routes = gizli("dahili", ["openai-compat"]) as LlmGatewayConfig["routes"];

    await expect(gateway.agentSession({ ...opts, resumeToken })).rejects.toBeInstanceOf(SessionPolicyChangedError);
    expect(runner.inputs).toHaveLength(1);
  });

  it("stops an open confidential session when onPremMissing flips to block", async () => {
    const { cfg, gateway, runner } = build({
      onPremMissing: "masked_cloud",
      routes: gizli("gizli", ["anthropic-direct"]),
    });
    const resumeToken = await openSession(gateway, { dataClass: "gizli" });

    cfg.onPremMissing = "block";

    expect(await gateway.agentSession({ ...opts, dataClass: "gizli", resumeToken })).toMatchObject({
      status: "blocked",
      dataClass: "gizli",
    });
    expect(runner.inputs).toHaveLength(1);
  });

  it("degrades an open session instead of resuming it when the policy degrades", async () => {
    const { cfg, gateway, runner } = build({
      onPremMissing: "masked_cloud",
      routes: gizli("gizli", ["anthropic-direct"]),
    });
    const resumeToken = await openSession(gateway, { dataClass: "gizli" });

    cfg.onPremMissing = "degrade_ai_assist";

    expect(await gateway.agentSession({ ...opts, dataClass: "gizli", resumeToken })).toMatchObject({
      status: "degraded",
      dataClass: "gizli",
    });
    expect(runner.inputs).toHaveLength(1);
  });
});

describe("agent turns are routed with the caller's data class (B4 · M18/M97)", () => {
  it("routes two turns of one gateway differently because their classes differ", async () => {
    const { gateway } = build({}, [turn("internal"), turn("confidential")]);

    const internal = await gateway.agentSession(opts);
    const confidential = await gateway.agentSession({ ...opts, dataClass: "gizli" });

    if (internal.status !== "ok" || confidential.status !== "ok") {
      return expect.unreachable("expected two ok outcomes");
    }
    expect(internal.log).toMatchObject({ driver: "anthropic-direct", dataClass: "dahili" });
    // Same gateway, same role, same variant — only the caller's class moved the
    // turn onto the on-prem lane. No config value can do this any more.
    expect(confidential.log).toMatchObject({ driver: "openai-compat", dataClass: "gizli" });
  });

  it("refuses a resume that arrives with a different data class than the session opened with", async () => {
    const { gateway, runner } = build({});
    const resumeToken = await openSession(gateway);

    await expect(gateway.agentSession({ ...opts, dataClass: "gizli", resumeToken })).rejects.toBeInstanceOf(
      SessionPolicyChangedError,
    );
    expect(runner.inputs).toHaveLength(1);
  });

  it("degrades rather than sending confidential work to the cloud when the GPU is missing", async () => {
    const runner = stubRunner([turn("turn 1")]);
    const disabled = parseGatewayConfig({
      ...raw,
      drivers: [cloudDriver, { ...onPremDriver, enabled: false }],
      routes: gizli("gizli", ["openai-compat"]),
    });
    const blind = new LlmGateway(
      disabled,
      gatewayDeps(stubFetch([]), fakeClock(), { agentRunner: runner, mask: piiMask() }),
    );

    expect(await blind.agentSession({ ...opts, dataClass: "gizli" })).toMatchObject({
      status: "degraded",
      dataClass: "gizli",
    });
    expect(runner.inputs).toHaveLength(0);
  });

  it("writes the variant the caller supplied, not a wildcard", async () => {
    const { gateway } = build({}, [turn("turn 1")]);
    const outcome = await gateway.agentSession({ ...opts, dataClass: "acik", variantId: "mobile-ios" });

    if (outcome.status !== "ok") return expect.unreachable("expected an ok outcome");
    expect(outcome.log).toMatchObject({ variantId: "mobile-ios", dataClass: "acik" });
  });
});
