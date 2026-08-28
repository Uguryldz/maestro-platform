import { describe, expect, it } from "vitest";
import { AuditCanonicalizationError, canonicalize, canonicalString } from "../src/index.js";

describe("canonical serialisation", () => {
  it("is independent of key insertion order", () => {
    const a = { ticket: "UGURPAY-1", app: "ugurweb", risk: "orta" };
    const b = { risk: "orta", app: "ugurweb", ticket: "UGURPAY-1" };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalize(a)).toBe('{"app":"ugurweb","risk":"orta","ticket":"UGURPAY-1"}');
  });

  it("sorts nested keys too and keeps array order", () => {
    const value = { b: [3, 1, 2], a: { z: true, y: null } };
    expect(canonicalize(value)).toBe('{"a":{"y":null,"z":true},"b":[3,1,2]}');
  });

  it("produces the same output for the same input every time", () => {
    const value = { nested: { list: [{ k: 1 }, { k: 2 }] }, at: new Date("2026-08-08T09:00:00.000Z") };
    const runs = new Set(Array.from({ length: 20 }, () => canonicalize(value)));
    expect(runs.size).toBe(1);
  });

  it("escapes the pipe so a string can never contain the chain separator", () => {
    expect(canonicalString("a|b")).toBe('"a\\u007cb"');
    expect(canonicalString("a|b")).not.toContain("|");
    // The collision the escape prevents: one field "a|b" vs two fields "a","b".
    expect(canonicalString("a|b")).not.toBe(`${canonicalString("a")}|${canonicalString("b")}`);
  });

  it("escapes quotes, backslashes, control characters and lone surrogates", () => {
    expect(canonicalize('say "hi"')).toBe('"say \\"hi\\""');
    expect(canonicalize("back\\slash")).toBe('"back\\\\slash"');
    expect(canonicalize("line\nbreak")).toBe('"line\\nbreak"');
    expect(canonicalize("\ud800")).toBe('"\\ud800"');
  });

  it("serialises dates as UTC ISO strings", () => {
    expect(canonicalize(new Date("2026-08-08T09:00:00.000Z"))).toBe('"2026-08-08T09:00:00.000Z"');
  });

  it("renders numbers in a single stable form", () => {
    expect(canonicalize({ i: 42, f: 1.5, neg: -0 })).toBe('{"f":1.5,"i":42,"neg":0}');
  });

  it("refuses values it cannot represent instead of dropping them", () => {
    const cases: [unknown, string][] = [
      [{ a: undefined }, "$.a"],
      [{ a: Number.NaN }, "$.a"],
      [{ a: Number.POSITIVE_INFINITY }, "$.a"],
      [{ a: 1n }, "$.a"],
      [{ a: () => 1 }, "$.a"],
      [{ a: Symbol("s") }, "$.a"],
      [{ a: new Map() }, "$.a"],
      [{ a: new Set() }, "$.a"],
      [{ a: /x/ }, "$.a"],
      [{ a: new Date("nope") }, "$.a"],
      [[undefined], "$[0]"],
    ];
    for (const [value, path] of cases) {
      expect(() => canonicalize(value)).toThrow(AuditCanonicalizationError);
      expect(() => canonicalize(value)).toThrow(`value at ${path}`);
    }
  });

  it("refuses circular structures", () => {
    const cycle: Record<string, unknown> = { name: "loop" };
    cycle["self"] = cycle;
    expect(() => canonicalize(cycle)).toThrow(AuditCanonicalizationError);
    expect(() => canonicalize(cycle)).toThrow("circular reference");
  });

  it("refuses class instances, which would silently serialise as {}", () => {
    class Payload {
      readonly hidden = "value";
    }
    expect(() => canonicalize({ a: new Payload() })).toThrow(/not a plain object/);
  });

  it("accepts objects with a null prototype", () => {
    const value = Object.assign(Object.create(null) as Record<string, unknown>, { b: 2, a: 1 });
    expect(canonicalize(value)).toBe('{"a":1,"b":2}');
  });
});
