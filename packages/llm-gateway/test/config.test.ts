import { describe, expect, it } from "vitest";
import { LlmConfigError, parseGatewayConfig } from "../src/index.js";

const routes = [
  { dataClass: "acik", allowedDrivers: ["anthropic-direct"] },
  { dataClass: "dahili", allowedDrivers: ["anthropic-direct"] },
  { dataClass: "gizli", allowedDrivers: ["openai-compat"] },
];

const anthropic = { driver: "anthropic-direct", apiKeyRef: "llm/anthropic" };

describe("parseGatewayConfig", () => {
  it("fills the documented defaults", () => {
    const cfg = parseGatewayConfig({
      drivers: [anthropic],
      bindings: [{ role: "analyst", driver: "anthropic-direct", model: "claude-x" }],
      routes,
    });

    expect(cfg.drivers[0]).toMatchObject({
      baseUrl: "https://api.anthropic.com",
      apiVersion: "2023-06-01",
      enabled: true,
      onPrem: false,
      timeoutMs: 60_000,
    });
    expect(cfg.bindings[0]?.variantId).toBe("*");
    expect(cfg.onPremMissing).toBe("degrade_ai_assist");
    expect(cfg.agentRole).toBe("engineer");
    // The data class of an agent turn is NOT config any more: `AgentSessionOptions`
    // carries it, so there is nothing here for the gateway to fall back to (M18).
    expect(cfg).not.toHaveProperty("agentDataClass");
    expect(cfg.retry).toEqual({ maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8_000, jitterRatio: 0 });
    expect(cfg.rateLimit).toEqual({ capacity: 10, refillPerSecond: 2 });
    expect(cfg.subscriptionPool).toEqual({ accounts: [], exhaustedAtPct: 95, cooldownMs: 0 });
  });

  it("rejects a binding whose driver is neither configured nor pooled", () => {
    expect(() =>
      parseGatewayConfig({
        drivers: [anthropic],
        bindings: [{ role: "analyst", driver: "openai-compat", model: "local" }],
        routes,
      }),
    ).toThrow(/bindings.0.driver/);
  });

  it("accepts a subscription binding backed by a pooled account", () => {
    const cfg = parseGatewayConfig({
      drivers: [anthropic],
      bindings: [{ role: "analyst", driver: "claude-sub", model: "claude-x" }],
      routes,
      subscriptionPool: {
        accounts: [
          {
            accountId: "sub-1",
            driver: "claude-sub",
            transport: "anthropic-direct",
            credentialRef: "llm/sub1",
            windows: [{ kind: "5h", costPctPerCall: 20 }, { kind: "weekly" }],
          },
        ],
      },
    });
    expect(cfg.subscriptionPool.accounts[0]?.windows).toEqual([
      { kind: "5h", costPctPerCall: 20 },
      { kind: "weekly", costPctPerCall: 1 },
    ]);
  });

  it("rejects a pooled account whose transport is not configured", () => {
    expect(() =>
      parseGatewayConfig({
        drivers: [anthropic],
        bindings: [{ role: "analyst", driver: "claude-sub", model: "claude-x" }],
        routes,
        subscriptionPool: {
          accounts: [
            {
              accountId: "sub-1",
              driver: "claude-sub",
              transport: "openai-compat",
              credentialRef: "llm/sub1",
              windows: [{ kind: "5h" }],
            },
          ],
        },
      }),
    ).toThrow(/transport "openai-compat" is not a configured driver/);
  });

  it("requires a route for every data class (fail-closed)", () => {
    expect(() =>
      parseGatewayConfig({
        drivers: [anthropic],
        bindings: [{ role: "analyst", driver: "anthropic-direct", model: "claude-x" }],
        routes: [{ dataClass: "acik", allowedDrivers: ["anthropic-direct"] }],
      }),
    ).toThrow(/no route for data class "dahili"/);
  });

  it("throws a typed config error listing every issue", () => {
    try {
      parseGatewayConfig({ drivers: [{ driver: "openai-compat", baseUrl: "not-a-url", apiKeyRef: "" }], routes: [] });
      expect.unreachable("expected a config error");
    } catch (error) {
      expect(error).toBeInstanceOf(LlmConfigError);
      expect((error as Error).message).toContain("drivers.0.baseUrl");
      expect((error as Error).message).toContain("bindings");
    }
  });
});
