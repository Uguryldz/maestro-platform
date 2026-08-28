import type { LlmDriverId } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import { AgentSessionStore, UnknownResumeTokenError, describePin, type SessionPin } from "../src/index.js";
import { fakeClock, idSequence } from "./helpers.js";

function store() {
  const clock = fakeClock();
  return { clock, store: new AgentSessionStore(idSequence(), clock.now) };
}

function pin(driver: LlmDriverId, model: string, over: Partial<SessionPin> = {}): SessionPin {
  return { driver, model, dataClass: "dahili", masked: false, ...over };
}

describe("AgentSessionStore (M17 delegation bookkeeping)", () => {
  it("issues a resume token pinned to the backend and workspace", () => {
    const { store: s } = store();
    const record = s.start(pin("claude-sub", "claude-x"), "/work/UGURPAY-1");

    expect(record).toMatchObject({
      resumeToken: "session-1",
      driver: "claude-sub",
      model: "claude-x",
      workspacePath: "/work/UGURPAY-1",
      vendorSessionId: null,
      turns: 0,
      createdAt: "2026-08-08T09:00:00.000Z",
    });
  });

  it("resumes the same backend and remembers the vendor handle", () => {
    const { clock, store: s } = store();
    const started = s.start(pin("claude-sub", "claude-x"), "/work/UGURPAY-1");
    s.complete(started.resumeToken, "vendor-abc");

    clock.advance(5_000);
    const resumed = s.resume(started.resumeToken, "/work/UGURPAY-1");

    expect(resumed).toMatchObject({ driver: "claude-sub", model: "claude-x", vendorSessionId: "vendor-abc", turns: 1 });
  });

  it("counts turns and moves updatedAt without touching createdAt", () => {
    const { clock, store: s } = store();
    const started = s.start(pin("anthropic-direct", "claude-x"), "/work/a");

    s.complete(started.resumeToken, "v1");
    clock.advance(60_000);
    const after = s.complete(started.resumeToken, null);

    expect(after.turns).toBe(2);
    expect(after.createdAt).toBe("2026-08-08T09:00:00.000Z");
    expect(after.updatedAt).toBe("2026-08-08T09:01:00.000Z");
    // A runner that keeps the old handle must not clear it.
    expect(after.vendorSessionId).toBe("v1");
  });

  it("refuses an unknown resume token instead of starting a fresh session", () => {
    const { store: s } = store();
    expect(() => s.resume("session-404", "/work/a")).toThrow(UnknownResumeTokenError);
    expect(() => s.complete("session-404", null)).toThrow(UnknownResumeTokenError);
  });

  it("refuses to resume a session in a different workspace", () => {
    const { store: s } = store();
    const started = s.start(pin("claude-sub", "claude-x"), "/work/a");

    expect(() => s.resume(started.resumeToken, "/work/b")).toThrow(/bound to workspace \/work\/a/);
  });

  it("pins the data class and the masking decision, not just the backend", () => {
    const { store: s } = store();
    const started = s.start(pin("anthropic-direct", "claude-x", { dataClass: "gizli", masked: true }), "/work/a");
    s.complete(started.resumeToken, null);

    const resumed = s.resume(started.resumeToken, "/work/a");
    expect(resumed).toMatchObject({ dataClass: "gizli", masked: true });
    expect(describePin(resumed)).toBe("anthropic-direct/claude-x (gizli, masked)");
  });

  it("keeps sessions independent", () => {
    const { store: s } = store();
    const first = s.start(pin("claude-sub", "claude-x"), "/work/a");
    const second = s.start(pin("anthropic-direct", "claude-y"), "/work/b");
    s.complete(first.resumeToken, "v1");

    expect(second.resumeToken).toBe("session-2");
    expect(s.resume(second.resumeToken, "/work/b").turns).toBe(0);
    expect(s.resume(first.resumeToken, "/work/a").turns).toBe(1);
  });
});
