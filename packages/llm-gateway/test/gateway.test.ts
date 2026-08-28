import { LlmCallLog } from "@maestro/contracts";
import type { LlmPort } from "@maestro/ports";
import { describe, expect, it } from "vitest";
import {
  LlmConfigError,
  LlmGateway,
  MSG_DEGRADED_AI_ASSIST,
  UnknownModelError,
  WINDOW_MS,
  createLlmGateway,
} from "../src/index.js";
import { ANSWER, Analysis, anthropicBody, build, config, request } from "./gateway-fixture.js";
import { SAMPLE_IBAN, fakeClock, gatewayDeps, piiMask, stubFetch } from "./helpers.js";

describe("LlmGateway.generateObject", () => {
  it("routes a subscription binding through the seat's transport and credential", async () => {
    const { gateway, stub } = build();
    const outcome = await gateway.generateObject(request, Analysis);

    expect(outcome.status).toBe("ok");
    expect(stub.calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(stub.calls[0]?.headers["x-api-key"]).toBe("sk-seat1");
    expect(stub.calls[0]?.body).toMatchObject({ model: "claude-sonnet" });
  });

  it("produces a contract-valid call log with usd null and the subscription driver", async () => {
    const { gateway, logs } = build({}, { runId: () => "run-abcdefgh" });
    const outcome = await gateway.generateObject(request, Analysis);

    if (outcome.status !== "ok") return expect.unreachable("expected an ok outcome");
    expect(outcome.value).toEqual({ risk: "orta", reason: "payment path touched" });
    expect(() => LlmCallLog.parse(outcome.log)).not.toThrow();
    expect(outcome.log).toEqual({
      at: "2026-08-08T09:00:00.000Z",
      runId: "run-abcdefgh",
      role: "analyst",
      variantId: "backend",
      driver: "claude-sub",
      model: "claude-sonnet",
      tokensIn: 125,
      tokensOut: 20,
      cachePct: 20,
      usd: null,
      dataClass: "dahili",
    });
    expect(logs).toEqual([outcome.log]);
  });

  it("queues with resumeAt instead of failing when the pool is exhausted (M55)", async () => {
    const { gateway, stub, clock } = build({}, {}, [{ body: anthropicBody(ANSWER) }]);
    await gateway.generateObject(request, Analysis);

    const queued = await gateway.generateObject(request, Analysis);
    expect(queued).toEqual({
      status: "queued",
      resumeAt: new Date(Date.parse("2026-08-08T09:00:00.000Z") + WINDOW_MS["5h"]).toISOString(),
      reason: "subscription_quota",
    });
    // The queued call never reached the provider.
    expect(stub.calls).toHaveLength(1);

    clock.advance(WINDOW_MS["5h"]);
    expect(gateway.poolSnapshot()[0]?.state).toBe("ready");
  });

  it("burns the seat's quota even when the provider call fails", async () => {
    const { gateway } = build({}, {}, [{ status: 400, body: { error: "bad model" } }]);

    await expect(gateway.generateObject(request, Analysis)).rejects.toThrow(/HTTP 400/);
    expect(gateway.poolSnapshot()[0]?.state).toBe("exhausted");
  });

  it("degrades a confidential request when no on-prem backend serves the role (M18)", async () => {
    const { gateway, stub } = build();
    const outcome = await gateway.generateObject({ ...request, dataClass: "gizli" }, Analysis);

    expect(outcome).toEqual({ status: "degraded", dataClass: "gizli", messageKey: MSG_DEGRADED_AI_ASSIST });
    expect(stub.calls).toHaveLength(0);
  });

  it("sends a confidential request to the on-prem backend when one is bound", async () => {
    const { gateway, stub } = build({}, {}, [
      {
        body: {
          choices: [{ message: { content: ANSWER } }],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        },
      },
    ]);

    const outcome = await gateway.generateObject(
      { ...request, role: "test_designer", dataClass: "gizli" },
      Analysis,
    );

    expect(outcome.status).toBe("ok");
    expect(stub.calls[0]?.url).toBe("https://vllm.internal.bank/v1/chat/completions");
    if (outcome.status === "ok") expect(outcome.log.driver).toBe("openai-compat");
  });

  it("refuses masked_cloud routing when no masker is wired (fail-closed)", async () => {
    const cloudGizli = {
      onPremMissing: "masked_cloud",
      routes: [
        { dataClass: "acik", allowedDrivers: ["anthropic-direct", "claude-sub"] },
        { dataClass: "dahili", allowedDrivers: ["anthropic-direct", "claude-sub"] },
        { dataClass: "gizli", allowedDrivers: ["anthropic-direct"] },
      ],
    };
    const { gateway, stub } = build(cloudGizli);

    await expect(
      gateway.generateObject({ ...request, role: "intake", dataClass: "gizli" }, Analysis),
    ).rejects.toBeInstanceOf(LlmConfigError);
    expect(stub.calls).toHaveLength(0);
  });

  it("masks the payload before a masked_cloud call leaves the bank", async () => {
    const cloudGizli = {
      onPremMissing: "masked_cloud",
      routes: [
        { dataClass: "acik", allowedDrivers: ["anthropic-direct", "claude-sub"] },
        { dataClass: "dahili", allowedDrivers: ["anthropic-direct", "claude-sub"] },
        { dataClass: "gizli", allowedDrivers: ["anthropic-direct"] },
      ],
    };
    const { gateway, stub } = build(cloudGizli, { mask: piiMask() });

    await gateway.generateObject(
      { ...request, role: "intake", dataClass: "gizli", input: { ticket: "UGURPAY-1", iban: SAMPLE_IBAN } },
      Analysis,
    );

    const sent = JSON.stringify(stub.calls[0]?.body);
    expect(sent).toContain("[IBAN_1."); // per-session nonce, see @maestro/pii B-8
    expect(sent).not.toContain(SAMPLE_IBAN);
  });

  it("rejects an unbound role and a malformed request", async () => {
    const { gateway } = build();
    await expect(gateway.generateObject({ ...request, role: "dev_reviewer" }, Analysis)).rejects.toBeInstanceOf(
      UnknownModelError,
    );
    await expect(gateway.generateObject({ ...request, variantId: "" }, Analysis)).rejects.toThrow();
  });
});

describe("LlmGateway wiring", () => {
  it("validates config before building anything", () => {
    expect(() => createLlmGateway({ ...config, bindings: [] }, gatewayDeps(stubFetch([]), fakeClock()))).toThrow(
      LlmConfigError,
    );
  });

  it("refuses to construct without a fetch implementation", () => {
    const deps = gatewayDeps(stubFetch([]), fakeClock());
    const originalFetch = globalThis.fetch;
    try {
      Reflect.deleteProperty(globalThis, "fetch");
      expect(() => createLlmGateway(config, { ...deps, fetchImpl: undefined })).toThrow(/no fetch implementation/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("exposes a contract-valid quota snapshot for Studio (M62)", () => {
    const { gateway } = build();
    expect(gateway.poolSnapshot()).toEqual([
      {
        accountId: "sub-1",
        driver: "claude-sub",
        state: "ready",
        lastUsedAt: null,
        windows: [
          { kind: "5h", usedPct: 0, resetsAt: new Date(Date.parse("2026-08-08T09:00:00.000Z") + WINDOW_MS["5h"]).toISOString() },
          { kind: "weekly", usedPct: 0, resetsAt: new Date(Date.parse("2026-08-08T09:00:00.000Z") + WINDOW_MS.weekly).toISOString() },
        ],
      },
    ]);
  });

  it("satisfies the frozen LlmPort interface", () => {
    const { gateway } = build();
    const port: LlmPort = gateway;

    expect(gateway).toBeInstanceOf(LlmGateway);
    expect(typeof port.generateObject).toBe("function");
    expect(typeof port.agentSession).toBe("function");
  });
});
