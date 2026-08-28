import { describe, expect, it } from "vitest";
import { AuditActorError, assertActor, humanBehind, isHumanActor, parseActor } from "../src/index.js";

describe("actor forms (M33 conventions, M101 delegation)", () => {
  it("accepts a corporate human account", () => {
    expect(parseActor("po.demir@ugurbank.corp")).toEqual({ kind: "human", user: "po.demir@ugurbank.corp" });
    expect(parseActor("u.yildiz+ops@corp")).toEqual({ kind: "human", user: "u.yildiz+ops@corp" });
  });

  it("accepts the two system actors and nothing else system-shaped", () => {
    expect(parseActor("maestro-worker")).toEqual({ kind: "system", system: "maestro-worker" });
    expect(parseActor("maestro-runner")).toEqual({ kind: "system", system: "maestro-runner" });
    expect(parseActor("maestro-bff")).toBeNull();
    expect(parseActor("maestro-worker-2")).toBeNull();
  });

  it("accepts ai-via:<user> and keeps the delegating human visible", () => {
    expect(parseActor("ai-via:po.demir@ugurbank.corp")).toEqual({
      kind: "ai_delegated",
      user: "po.demir@ugurbank.corp",
    });
    expect(humanBehind("ai-via:po.demir@ugurbank.corp")).toBe("po.demir@ugurbank.corp");
    expect(humanBehind("po.demir@ugurbank.corp")).toBe("po.demir@ugurbank.corp");
    expect(humanBehind("maestro-worker")).toBeNull();
  });

  it("does not treat an AI delegate as a human (M32)", () => {
    expect(isHumanActor("po.demir@ugurbank.corp")).toBe(true);
    expect(isHumanActor("ai-via:po.demir@ugurbank.corp")).toBe(false);
    expect(isHumanActor("maestro-worker")).toBe(false);
  });

  it("rejects everything outside the four permitted forms", () => {
    const rejected = [
      "",
      "   ",
      " po.demir@ugurbank.corp",
      "po.demir@ugurbank.corp ",
      "po.demir",
      "@corp",
      "po.demir@",
      "ai-via:",
      "ai-via:maestro-worker",
      "ai-via:ai-via:po@corp",
      "po demir@corp",
      "po|demir@corp",
      "system",
      "root",
    ];
    for (const actor of rejected) {
      expect(parseActor(actor), actor).toBeNull();
      expect(() => assertActor(actor), actor).toThrow(AuditActorError);
    }
  });

  it("names the accepted forms when it refuses", () => {
    expect(() => assertActor("root")).toThrow(/user@corp/);
    expect(() => assertActor("root")).toThrow(/ai-via:<user>/);
  });
});
