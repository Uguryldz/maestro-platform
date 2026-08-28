import { describe, expect, it } from "vitest";
import { accountDetector, compileAccountPatterns } from "../src/detectors/index.js";
import { PiiPolicyError } from "../src/errors.js";

const patterns = compileAccountPatterns([
  { name: "customer-no", pattern: "\\bMST-[0-9]{8}\\b" },
  { name: "account-no", pattern: "\\bHSP[0-9]{10}\\b" },
]);

describe("configurable account/customer detector", () => {
  it("finds every configured shape", () => {
    const found = accountDetector.scan("MST-12345678 hesabi HSP0011223344 ile eslesti", {
      accountPatterns: patterns,
    });
    expect(found.map((m) => m.text).sort()).toEqual(["HSP0011223344", "MST-12345678"]);
  });

  it("is inert when the profile configures no pattern", () => {
    expect(accountDetector.scan("MST-12345678", { accountPatterns: [] })).toEqual([]);
  });

  it("normalises case so one identifier gets one token", () => {
    const [match] = accountDetector.scan("mst-12345678", {
      accountPatterns: compileAccountPatterns([{ name: "c", pattern: "\\bmst-[0-9]{8}\\b" }]),
    });
    expect(match?.canonical).toBe("MST-12345678");
  });

  it("does not carry lastIndex state between scans", () => {
    const ctx = { accountPatterns: patterns };
    expect(accountDetector.scan("MST-12345678", ctx)).toHaveLength(1);
    expect(accountDetector.scan("MST-12345678", ctx)).toHaveLength(1);
  });

  it("rejects a broken pattern at load time, not at call time", () => {
    expect(() => compileAccountPatterns([{ name: "bad", pattern: "MST-([0-9]" }])).toThrow(
      PiiPolicyError,
    );
  });

  it("rejects a pattern that matches the empty string", () => {
    expect(() => compileAccountPatterns([{ name: "empty", pattern: "[0-9]*" }])).toThrow(
      PiiPolicyError,
    );
  });
});
