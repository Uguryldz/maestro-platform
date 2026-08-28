import { describe, expect, it } from "vitest";
import { LlmConfigError, LlmPolicy, parseGatewayConfig, type LlmGatewayConfig } from "../src/index.js";

/**
 * B1 regression (M18/M63): a subscription seat is a consumer contract with no
 * enterprise data-processing agreement, so the `gizli` class must not reach one
 * — not through the on-prem search, and not through the `masked_cloud` fallback
 * either. Two independent gates prove it: the config gate refuses to store such
 * a route at all, and the policy refuses to pick such a driver even when a
 * hand-built config slips past the gate.
 */

const drivers = [
  { driver: "anthropic-direct", apiKeyRef: "llm/anthropic" },
  { driver: "openai-compat", baseUrl: "https://vllm.internal.bank", apiKeyRef: "llm/vllm", onPrem: true },
];

// Both rows are wildcard rows: the subscription seat is declared first, so it
// wins `usable[0]` — which is exactly how the leak happened.
const bindings = [
  { role: "analyst", driver: "claude-sub", model: "claude-any" },
  { role: "analyst", driver: "anthropic-direct", model: "claude-cloud" },
];

const subscriptionPool = {
  accounts: [
    {
      accountId: "sub-1",
      driver: "claude-sub",
      transport: "anthropic-direct",
      credentialRef: "llm/sub1",
      windows: [{ kind: "5h" }],
    },
  ],
};

function routes(gizli: string[]) {
  return [
    { dataClass: "acik", allowedDrivers: ["anthropic-direct", "claude-sub"] },
    { dataClass: "dahili", allowedDrivers: ["anthropic-direct", "claude-sub"] },
    { dataClass: "gizli", allowedDrivers: gizli },
  ];
}

/** A legal config whose gizli route is then rewritten by hand. */
function smuggle(gizli: LlmGatewayConfig["routes"][number]["allowedDrivers"]): LlmPolicy {
  const cfg = parseGatewayConfig({
    drivers,
    bindings,
    routes: routes(["openai-compat"]),
    subscriptionPool,
    onPremMissing: "masked_cloud",
  });
  const rewritten: LlmGatewayConfig = {
    ...cfg,
    routes: cfg.routes.map((r) => (r.dataClass === "gizli" ? { ...r, allowedDrivers: gizli } : r)),
  };
  // Nothing is on-prem, so masked_cloud is the only branch left.
  return new LlmPolicy(rewritten, () => false, () => true);
}

describe("confidential class never reaches a subscription seat (B1 · M18)", () => {
  it("refuses a subscription driver on the gizli route at config time", () => {
    expect(() => parseGatewayConfig({ drivers, bindings, routes: routes(["claude-sub"]), subscriptionPool })).toThrow(
      LlmConfigError,
    );
    expect(() =>
      parseGatewayConfig({ drivers, bindings, routes: routes(["openai-compat", "gemini-sub"]), subscriptionPool }),
    ).toThrow(/routes\.2\.allowedDrivers\.1.+gemini-sub.+gizli/);
  });

  it("still allows subscription drivers on the non-confidential routes", () => {
    const cfg = parseGatewayConfig({ drivers, bindings, routes: routes(["openai-compat"]), subscriptionPool });
    expect(cfg.routes[0]?.allowedDrivers).toContain("claude-sub");
  });

  it("refuses a subscription driver under masked_cloud even if the config gate is bypassed", () => {
    expect(smuggle(["claude-sub"]).resolve("analyst", "any", "gizli")).toMatchObject({
      kind: "block",
      dataClass: "gizli",
    });
  });

  it("picks the API driver, not the seat, when masked_cloud has both on offer", () => {
    expect(smuggle(["claude-sub", "anthropic-direct"]).resolve("analyst", "any", "gizli")).toEqual({
      kind: "allow",
      driver: "anthropic-direct",
      model: "claude-cloud",
      masked: true,
    });
  });
});
