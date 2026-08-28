import type { GenerateObjectRequest, LlmCallLog } from "@maestro/contracts";
import { z } from "zod";
import { createLlmGateway, type LlmGatewayDeps } from "../src/index.js";
import { type StubResponse, fakeClock, gatewayDeps, stubFetch, stubSecrets } from "./helpers.js";

/** The deployment both gateway suites are written against. */
export const Analysis = z.object({ risk: z.enum(["dusuk", "orta", "kritik"]), reason: z.string().min(1) });
export const ANSWER = '{"risk":"orta","reason":"payment path touched"}';

export function anthropicBody(text: string) {
  return { content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 25 } };
}

export const config = {
  drivers: [
    { driver: "anthropic-direct", apiKeyRef: "llm/anthropic" },
    { driver: "openai-compat", baseUrl: "https://vllm.internal.bank", apiKeyRef: "llm/vllm", onPrem: true },
  ],
  bindings: [
    { role: "analyst", driver: "claude-sub", model: "claude-sonnet" },
    { role: "intake", driver: "anthropic-direct", model: "claude-haiku" },
    { role: "engineer", driver: "claude-sub", model: "claude-sonnet" },
    { role: "test_designer", driver: "openai-compat", model: "qwen-onprem" },
  ],
  routes: [
    { dataClass: "acik", allowedDrivers: ["anthropic-direct", "openai-compat", "claude-sub"] },
    { dataClass: "dahili", allowedDrivers: ["anthropic-direct", "openai-compat", "claude-sub"] },
    { dataClass: "gizli", allowedDrivers: ["openai-compat"] },
  ],
  subscriptionPool: {
    accounts: [
      {
        accountId: "sub-1",
        driver: "claude-sub",
        transport: "anthropic-direct",
        credentialRef: "llm/seat1",
        windows: [
          { kind: "5h", costPctPerCall: 95 },
          { kind: "weekly", costPctPerCall: 1 },
        ],
      },
    ],
  },
};

export const request: GenerateObjectRequest = {
  role: "analyst",
  variantId: "backend",
  dataClass: "dahili",
  schemaName: "Analysis",
  input: { ticket: "UGURPAY-1" },
};

export function build(
  over: Record<string, unknown> = {},
  extraDeps: Partial<LlmGatewayDeps> = {},
  responses: StubResponse[] = [{ body: anthropicBody(ANSWER) }],
) {
  const stub = stubFetch(responses);
  const clock = fakeClock();
  const logs: LlmCallLog[] = [];
  const deps = gatewayDeps(stub, clock, {
    secrets: stubSecrets({ "llm/seat1": "sk-seat1", "llm/anthropic": "sk-ant", "llm/vllm": "sk-vllm" }),
    onCallLog: (log) => logs.push(log),
    ...extraDeps,
  });
  const gateway = createLlmGateway({ ...config, ...over }, deps);
  return { gateway, stub, clock, logs };
}
