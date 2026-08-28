import { SubscriptionAccount } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import { LlmConfigError, SubscriptionPool, SubscriptionPoolConfig, WINDOW_MS } from "../src/index.js";
import { fakeClock } from "./helpers.js";

const START = "2026-08-08T09:00:00.000Z";
const startMs = Date.parse(START);

function seat(accountId: string, over: Record<string, unknown> = {}) {
  return {
    accountId,
    driver: "claude-sub",
    transport: "anthropic-direct",
    credentialRef: `llm/${accountId}`,
    windows: [
      { kind: "5h", costPctPerCall: 10 },
      { kind: "weekly", costPctPerCall: 1 },
    ],
    ...over,
  };
}

function pool(accounts: unknown[], over: Record<string, unknown> = {}) {
  const clock = fakeClock(START);
  const cfg = SubscriptionPoolConfig.parse({ accounts, ...over });
  return { clock, pool: new SubscriptionPool(cfg, clock.now) };
}

describe("SubscriptionPool (M55)", () => {
  it("prefers the account with the most headroom and rotates on tie", () => {
    const { pool: p } = pool([seat("a"), seat("b")]);

    // Fresh pool: the tie breaks to the never-used seat, then by id.
    expect(p.acquire("claude-sub")).toMatchObject({ ok: true, account: { accountId: "a" } });
    p.record("a");
    // "a" now has less headroom than "b".
    expect(p.acquire("claude-sub")).toMatchObject({ ok: true, account: { accountId: "b" } });
  });

  it("hands over the seat's own credential and transport", () => {
    const { pool: p } = pool([seat("a", { credentialRef: "llm/sub-a", transport: "openai-compat" })]);

    expect(p.acquire("claude-sub")).toEqual({
      ok: true,
      account: { accountId: "a", transport: "openai-compat", credentialRef: "llm/sub-a" },
    });
  });

  it("skips an exhausted account and uses the next one", () => {
    const { pool: p } = pool([seat("a", { windows: [{ kind: "5h", costPctPerCall: 95 }] }), seat("b")]);
    p.record("a");

    expect(p.snapshot().find((s) => s.accountId === "a")?.state).toBe("exhausted");
    expect(p.acquire("claude-sub")).toMatchObject({ ok: true, account: { accountId: "b" } });
  });

  it("skips a cooling account until the cooldown elapses", () => {
    const { clock, pool: p } = pool([seat("a")], { cooldownMs: 60_000 });
    p.record("a");

    expect(p.snapshot()[0]?.state).toBe("cooling");
    expect(p.acquire("claude-sub")).toEqual({ ok: false, resumeAt: "2026-08-08T09:01:00.000Z" });

    clock.advance(60_000);
    expect(p.acquire("claude-sub")).toMatchObject({ ok: true });
  });

  it("queues with a resumeAt instead of failing when the whole pool is full", () => {
    const full = { windows: [{ kind: "5h", costPctPerCall: 95 }, { kind: "weekly", costPctPerCall: 1 }] };
    const { pool: p } = pool([seat("a", full), seat("b", full)]);
    p.record("a");
    p.record("b");

    expect(p.acquire("claude-sub")).toEqual({
      ok: false,
      resumeAt: new Date(startMs + WINDOW_MS["5h"]).toISOString(),
    });
  });

  it("resumes at the LAST blocking window, not the first", () => {
    const { pool: p } = pool([
      seat("a", { windows: [{ kind: "5h", costPctPerCall: 95 }, { kind: "weekly", costPctPerCall: 95 }] }),
    ]);
    p.record("a");

    // The 5h window frees first, but the weekly cap still blocks the seat.
    expect(p.acquire("claude-sub")).toEqual({
      ok: false,
      resumeAt: new Date(startMs + WINDOW_MS.weekly).toISOString(),
    });
  });

  it("frees the pool again once the window rolls over", () => {
    const { clock, pool: p } = pool([
      seat("a", { windows: [{ kind: "5h", costPctPerCall: 95 }, { kind: "weekly", costPctPerCall: 1 }] }),
    ]);
    p.record("a");
    expect(p.acquire("claude-sub").ok).toBe(false);

    clock.advance(WINDOW_MS["5h"]);
    expect(p.snapshot()[0]?.windows.find((w) => w.kind === "5h")?.usedPct).toBe(0);
    // …and acquiring again immediately reserves the next call's share.
    expect(p.acquire("claude-sub")).toMatchObject({ ok: true, account: { accountId: "a" } });
    expect(p.snapshot()[0]?.windows.find((w) => w.kind === "5h")?.usedPct).toBe(95);
  });

  it("rolls a window forward by whole periods, not to now()", () => {
    const { clock, pool: p } = pool([seat("a")]);
    p.record("a");
    clock.advance(WINDOW_MS["5h"] * 2 + 1_000);

    const window = p.snapshot()[0]?.windows.find((w) => w.kind === "5h");
    expect(window?.usedPct).toBe(0);
    expect(window?.resetsAt).toBe(new Date(startMs + WINDOW_MS["5h"] * 3).toISOString());
  });

  it("keeps the weekly window burning while the 5h window resets", () => {
    const { clock, pool: p } = pool([
      seat("a", { windows: [{ kind: "5h", costPctPerCall: 30 }, { kind: "weekly", costPctPerCall: 30 }] }),
    ]);
    p.record("a");
    clock.advance(WINDOW_MS["5h"]);
    p.record("a");

    const snapshot = p.snapshot()[0];
    expect(snapshot?.windows.find((w) => w.kind === "5h")?.usedPct).toBe(30);
    expect(snapshot?.windows.find((w) => w.kind === "weekly")?.usedPct).toBe(60);
  });

  it("caps usage at 100 percent and reports a contract-valid snapshot", () => {
    const { pool: p } = pool([seat("a", { windows: [{ kind: "5h", costPctPerCall: 60 }] })]);
    p.record("a");
    p.record("a");

    const snapshot = p.snapshot();
    expect(() => snapshot.map((s) => SubscriptionAccount.parse(s))).not.toThrow();
    expect(snapshot[0]?.windows[0]?.usedPct).toBe(100);
    expect(snapshot[0]?.lastUsedAt).toBe(START);
    expect(snapshot[0]?.state).toBe("exhausted");
  });

  it("reports a disabled account as disabled and never selects it", () => {
    const { pool: p } = pool([seat("a", { enabled: false }), seat("b")]);

    expect(p.snapshot().find((s) => s.accountId === "a")?.state).toBe("disabled");
    expect(p.acquire("claude-sub")).toMatchObject({ ok: true, account: { accountId: "b" } });
  });

  it("treats a driver with no enabled seat as misconfiguration, not a queue", () => {
    const { pool: p } = pool([seat("a")]);
    expect(() => p.acquire("gemini-sub")).toThrow(LlmConfigError);
  });

  it("rejects duplicate account ids and unknown record targets", () => {
    expect(() => pool([seat("a"), seat("a")])).toThrow(/duplicate subscription account/);
    const { pool: p } = pool([seat("a")]);
    expect(() => p.record("nope")).toThrow(LlmConfigError);
  });

  it("isolates drivers: a full claude pool does not block gemini seats", () => {
    const { pool: p } = pool([
      seat("a", { windows: [{ kind: "5h", costPctPerCall: 95 }] }),
      seat("g", { driver: "gemini-sub", transport: "google-vertex" }),
    ]);
    p.record("a");

    expect(p.acquire("claude-sub").ok).toBe(false);
    expect(p.acquire("gemini-sub")).toMatchObject({ ok: true, account: { accountId: "g" } });
  });
});
