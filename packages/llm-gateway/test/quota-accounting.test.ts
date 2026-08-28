import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SubscriptionPool, SubscriptionPoolConfig, createLlmGateway } from "../src/index.js";
import { type StubResponse, fakeClock, gatewayDeps, stubFetch, stubSecrets } from "./helpers.js";

/**
 * B5/B6 regressions (M55). Quota is the only cost signal a subscription seat
 * has, so it has to be right in the two places the original got it wrong:
 * `acquire()` must reserve at selection time (otherwise parallel callers all
 * see an empty seat), and one logical call must burn every PHYSICAL provider
 * call it caused — schema repair rounds and HTTP retries included.
 */

const START = "2026-08-08T09:00:00.000Z";

function seat(accountId: string, costPctPerCall: number) {
  return {
    accountId,
    driver: "claude-sub",
    transport: "anthropic-direct",
    credentialRef: `llm/${accountId}`,
    windows: [{ kind: "5h", costPctPerCall }],
  };
}

function pool(accounts: unknown[]) {
  const clock = fakeClock(START);
  return { clock, pool: new SubscriptionPool(SubscriptionPoolConfig.parse({ accounts }), clock.now) };
}

function usedOf(snapshot: { accountId: string; windows: { usedPct: number }[] }[], accountId: string): number {
  return snapshot.find((s) => s.accountId === accountId)?.windows[0]?.usedPct ?? -1;
}

describe("SubscriptionPool reserves at acquire time (B5 · M55)", () => {
  it("spreads parallel acquisitions across the seats instead of hammering one", () => {
    const { pool: p } = pool([seat("a", 5), seat("b", 5)]);

    // 20 callers in flight before any of them reports back — exactly the shape
    // of a fan-out step. Without a reservation every one of them sees an empty
    // seat and the pool degenerates to a single account.
    const chosen = Array.from({ length: 20 }, () => {
      const result = p.acquire("claude-sub");
      if (!result.ok) return "queued";
      return result.account.accountId;
    });

    expect(chosen.filter((id) => id === "a")).toHaveLength(10);
    expect(chosen.filter((id) => id === "b")).toHaveLength(10);
    const snapshot = p.snapshot();
    expect(usedOf(snapshot, "a")).toBe(50);
    expect(usedOf(snapshot, "b")).toBe(50);
  });

  it("queues parallel callers once the reservations fill the pool", () => {
    const { pool: p } = pool([seat("a", 50)]);

    expect(p.acquire("claude-sub").ok).toBe(true);
    expect(p.acquire("claude-sub").ok).toBe(true);
    // Two reservations already put the seat at 100% — the third waits.
    expect(p.acquire("claude-sub").ok).toBe(false);
  });

  it("reconciles the reservation with the real call count, and never double-counts", () => {
    const { pool: p } = pool([seat("a", 10)]);

    const first = p.acquire("claude-sub");
    expect(first.ok).toBe(true);
    // One logical call that took three physical attempts: 10% is already
    // reserved, so only the two extra attempts are added.
    p.record("a", 3);
    expect(usedOf(p.snapshot(), "a")).toBe(30);

    p.acquire("claude-sub");
    p.record("a");
    expect(usedOf(p.snapshot(), "a")).toBe(40);
  });

  it("keeps the reservation when the call fails, without double-counting it", () => {
    const { pool: p } = pool([seat("a", 10)]);
    p.acquire("claude-sub");
    expect(usedOf(p.snapshot(), "a")).toBe(10);

    // The failing call still reports its single attempt; the seat stays at 10%.
    p.record("a", 1);
    expect(usedOf(p.snapshot(), "a")).toBe(10);
  });
});

const Answer = z.object({ risk: z.string().min(1) });
const OK = '{"risk":"orta"}';

function anthropicBody(text: string) {
  return { content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 4 } };
}

const config = {
  drivers: [{ driver: "anthropic-direct", apiKeyRef: "llm/anthropic" }],
  bindings: [{ role: "analyst", driver: "claude-sub", model: "claude-x" }],
  routes: [
    { dataClass: "acik", allowedDrivers: ["anthropic-direct", "claude-sub"] },
    { dataClass: "dahili", allowedDrivers: ["anthropic-direct", "claude-sub"] },
    { dataClass: "gizli", allowedDrivers: ["anthropic-direct"] },
  ],
  subscriptionPool: { accounts: [seat("sub-1", 10)] },
  retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 },
};

const request = { role: "analyst", variantId: "backend", dataClass: "dahili", schemaName: "Answer", input: { t: 1 } } as const;

function gateway(responses: StubResponse[]) {
  const stub = stubFetch(responses);
  const deps = gatewayDeps(stub, fakeClock(START), { secrets: stubSecrets({ "llm/sub-1": "sk-seat" }) });
  return { stub, gateway: createLlmGateway(config, deps) };
}

describe("one logical call burns every provider call it caused (B6 · M55)", () => {
  it("counts the schema repair round", async () => {
    const { gateway: gw, stub } = gateway([{ body: anthropicBody("not json at all") }, { body: anthropicBody(OK) }]);

    const outcome = await gw.generateObject(request, Answer);
    expect(outcome.status).toBe("ok");
    expect(stub.calls).toHaveLength(2);
    expect(usedOf(gw.poolSnapshot(), "sub-1")).toBe(20);
  });

  it("counts HTTP retries, including the ones that end in a failure", async () => {
    const { gateway: gw, stub } = gateway([
      { status: 503, body: { error: "overloaded" } },
      { status: 503, body: { error: "overloaded" } },
      { status: 503, body: { error: "overloaded" } },
    ]);

    await expect(gw.generateObject(request, Answer)).rejects.toThrow(/HTTP 503/);
    expect(stub.calls).toHaveLength(3);
    expect(usedOf(gw.poolSnapshot(), "sub-1")).toBe(30);
  });

  it("counts retries and repair rounds together", async () => {
    const { gateway: gw, stub } = gateway([
      { status: 503, body: { error: "overloaded" } },
      { body: anthropicBody("prose, no json") },
      { status: 429, body: { error: "slow down" }, headers: { "retry-after": "0" } },
      { body: anthropicBody(OK) },
    ]);

    const outcome = await gw.generateObject(request, Answer);
    expect(outcome.status).toBe("ok");
    expect(stub.calls).toHaveLength(4);
    expect(usedOf(gw.poolSnapshot(), "sub-1")).toBe(40);
  });
});
