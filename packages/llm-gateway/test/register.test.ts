import type { LlmPort } from "@maestro/ports";
import { PortRegistry } from "@maestro/ports";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LLM_GATEWAY_DRIVER, LLM_PORT, LlmConfigError, LlmGateway, registerLlmDrivers } from "../src/index.js";
import { fakeClock, gatewayDeps, stubFetch } from "./helpers.js";

const config = {
  drivers: [{ driver: "anthropic-direct", apiKeyRef: "llm/anthropic" }],
  bindings: [{ role: "analyst", driver: "anthropic-direct", model: "claude-x" }],
  routes: [
    { dataClass: "acik", allowedDrivers: ["anthropic-direct"] },
    { dataClass: "dahili", allowedDrivers: ["anthropic-direct"] },
    { dataClass: "gizli", allowedDrivers: ["anthropic-direct"] },
  ],
};

function deps() {
  return gatewayDeps(stubFetch([]), fakeClock());
}

describe("registerLlmDrivers (M44 registry)", () => {
  it("registers the gateway under the llm port", () => {
    const registry = new PortRegistry();
    registerLlmDrivers(registry, deps());

    expect(registry.drivers(LLM_PORT)).toEqual([LLM_GATEWAY_DRIVER]);
    expect(registry.resolve<LlmPort>(LLM_PORT, LLM_GATEWAY_DRIVER)(config)).toBeInstanceOf(LlmGateway);
  });

  it("validates the config when the factory runs, not later at call time", () => {
    const registry = new PortRegistry();
    registerLlmDrivers(registry, deps());
    const factory = registry.resolve<LlmPort>(LLM_PORT, LLM_GATEWAY_DRIVER);

    expect(() => factory({ ...config, routes: [] })).toThrow(LlmConfigError);
    expect(() => factory({})).toThrow(LlmConfigError);
  });

  it("refuses a duplicate registration", () => {
    const registry = new PortRegistry();
    registerLlmDrivers(registry, deps());

    expect(() => registerLlmDrivers(registry, deps())).toThrow(/duplicate driver/);
  });

  it("wires the injected collaborators through to the built gateway", async () => {
    const registry = new PortRegistry();
    const stub = stubFetch([
      {
        body: {
          content: [{ type: "text", text: '{"ok":true}' }],
          usage: { input_tokens: 4, output_tokens: 2 },
        },
      },
    ]);
    registerLlmDrivers(registry, gatewayDeps(stub, fakeClock()));

    const gateway = registry.resolve<LlmPort>(LLM_PORT, LLM_GATEWAY_DRIVER)(config);
    const outcome = await gateway.generateObject(
      { role: "analyst", variantId: "backend", dataClass: "dahili", schemaName: "Ok", input: {} },
      z.object({ ok: z.boolean() }),
    );

    if (outcome.status !== "ok") return expect.unreachable("expected an ok outcome");
    expect(stub.calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(outcome.log.at).toBe("2026-08-08T09:00:00.000Z");
    expect(outcome.log.usd).toBeNull();
  });
});
