import { describe, expect, it } from "vitest";
import {
  LlmPolicy,
  MSG_BLOCKED_CONFIDENTIAL,
  MSG_BLOCKED_ROUTE,
  MSG_DEGRADED_AI_ASSIST,
  UnknownModelError,
  parseGatewayConfig,
} from "../src/index.js";

const drivers = [
  { driver: "anthropic-direct", apiKeyRef: "llm/anthropic" },
  { driver: "openai-compat", baseUrl: "https://vllm.internal.bank", apiKeyRef: "llm/vllm", onPrem: true },
];

const routes = [
  { dataClass: "acik", allowedDrivers: ["anthropic-direct", "openai-compat", "claude-sub"] },
  { dataClass: "dahili", allowedDrivers: ["anthropic-direct", "openai-compat", "claude-sub"] },
  { dataClass: "gizli", allowedDrivers: ["openai-compat"] },
];

const bindings = [
  { role: "analyst", variantId: "backend", driver: "anthropic-direct", model: "claude-backend" },
  { role: "analyst", driver: "claude-sub", model: "claude-any" },
  { role: "engineer", driver: "openai-compat", model: "qwen-onprem" },
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

function policy(over: Record<string, unknown> = {}, onPremDrivers = ["openai-compat"], enabled = ["anthropic-direct", "openai-compat"]) {
  const cfg = parseGatewayConfig({ drivers, bindings, routes, subscriptionPool, ...over });
  return new LlmPolicy(
    cfg,
    (id) => onPremDrivers.includes(id),
    (id) => enabled.includes(id) || id.endsWith("-sub"),
  );
}

describe("LlmPolicy (M18/M19)", () => {
  it("prefers the exact variant binding over the wildcard row", () => {
    expect(policy().resolve("analyst", "backend", "dahili")).toEqual({
      kind: "allow",
      driver: "anthropic-direct",
      model: "claude-backend",
      masked: false,
    });
  });

  it("falls back to the wildcard binding for an unlisted variant", () => {
    expect(policy().resolve("analyst", "mobile-ios", "dahili")).toMatchObject({
      driver: "claude-sub",
      model: "claude-any",
    });
  });

  it("is an error, never a silent fallback, when no binding matches the role", () => {
    expect(() => policy().resolve("test_designer", "backend", "dahili")).toThrow(UnknownModelError);
  });

  it("keeps the confidential class on-prem even when a cloud binding matches first", () => {
    // "gizli" allows openai-compat only, and engineer is bound to it.
    expect(policy().resolve("engineer", "backend", "gizli")).toEqual({
      kind: "allow",
      driver: "openai-compat",
      model: "qwen-onprem",
      masked: false,
    });
  });

  it("degrades by default when no on-prem backend can serve the confidential class", () => {
    // analyst has no on-prem binding at all.
    expect(policy().resolve("analyst", "backend", "gizli")).toEqual({
      kind: "degrade",
      dataClass: "gizli",
      messageKey: MSG_DEGRADED_AI_ASSIST,
    });
  });

  it("degrades when the on-prem driver exists but is disabled (GPU not installed yet)", () => {
    const disabled = policy({}, [], ["anthropic-direct"]);
    expect(disabled.resolve("engineer", "backend", "gizli")).toMatchObject({ kind: "degrade" });
  });

  it("blocks instead of degrading when the compliance team chose block", () => {
    const blocking = policy({ onPremMissing: "block" }, [], ["anthropic-direct"]);

    // Block and degrade are two DECISIONS, told apart by `kind` — not one error
    // whose message key the caller would have to parse (M18).
    expect(blocking.resolve("engineer", "backend", "gizli")).toEqual({
      kind: "block",
      dataClass: "gizli",
      messageKey: MSG_BLOCKED_CONFIDENTIAL,
    });
  });

  it("allows a masked cloud call only when the route itself permits that driver", () => {
    const masked = policy(
      {
        onPremMissing: "masked_cloud",
        routes: [
          { dataClass: "acik", allowedDrivers: ["anthropic-direct"] },
          { dataClass: "dahili", allowedDrivers: ["anthropic-direct"] },
          { dataClass: "gizli", allowedDrivers: ["anthropic-direct"] },
        ],
      },
      [],
    );

    expect(masked.resolve("analyst", "backend", "gizli")).toEqual({
      kind: "allow",
      driver: "anthropic-direct",
      model: "claude-backend",
      masked: true,
    });
  });

  it("blocks under masked_cloud when the route permits nothing usable", () => {
    const masked = policy({ onPremMissing: "masked_cloud" }, [], ["anthropic-direct"]);
    expect(masked.resolve("engineer", "backend", "gizli")).toMatchObject({ kind: "block", dataClass: "gizli" });
  });

  it("blocks a non-confidential class whose route forbids every bound driver", () => {
    const narrowed = policy({
      routes: [
        { dataClass: "acik", allowedDrivers: ["openai-compat"] },
        { dataClass: "dahili", allowedDrivers: ["anthropic-direct"] },
        { dataClass: "gizli", allowedDrivers: ["openai-compat"] },
      ],
    });

    // "acik" only allows openai-compat, but analyst/backend is bound to anthropic.
    // The message key names the ROUTE, not the confidential class the request is not in.
    expect(narrowed.resolve("analyst", "backend", "acik")).toEqual({
      kind: "block",
      dataClass: "acik",
      messageKey: MSG_BLOCKED_ROUTE,
    });
  });

  it("never routes a subscription driver to the confidential class", () => {
    // The config gate refuses the route outright, so the only way to hold such
    // a config is to build it by hand — which the policy then still refuses.
    // (Both gates are exercised end to end in confidential-routing.test.ts.)
    const cfg = parseGatewayConfig({ drivers, bindings, routes, subscriptionPool });
    const smuggled = {
      ...cfg,
      routes: cfg.routes.map((r) =>
        r.dataClass === "gizli" ? { ...r, allowedDrivers: ["claude-sub" as const] } : r,
      ),
    };
    // Even if someone mislabels the subscription driver as on-prem.
    const subOnPrem = new LlmPolicy(smuggled, (id) => id === "claude-sub", () => true);

    expect(subOnPrem.resolve("analyst", "any", "gizli")).toMatchObject({ kind: "degrade" });
  });
});
