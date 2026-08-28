import { describe, expect, it } from "vitest";
import { ciFingerprint, ciSignals, normalizeNoise, type CiFailureInput } from "../src/ci-fingerprint.js";

function failure(output: string, over: Partial<CiFailureInput> = {}): CiFailureInput[] {
  return [{ name: "test", exitCode: 1, output, ...over }];
}

/**
 * Real vitest output for one broken test, as two separate runs would print it:
 * a different workspace, a different correlation id the test logs, different
 * durations, different line numbers after an edit.
 */
function vitestRun(workspace: string, correlationId: string, durationMs: number, line: number): string {
  return [
    `FAIL src/pay/mapper.test.ts > PaymentMapper > maps a null account (${durationMs}ms)`,
    "AssertionError: expected undefined to be '0000'",
    `  correlation id: ${correlationId}`,
    `  at ${workspace}/src/pay/mapper.ts:${line}:3`,
    `  at ${workspace}/node_modules/.vite/deps/chunk-4f3a9b2.js:12:9`,
  ].join("\n");
}

describe("ciFingerprint — two runs of ONE failure collapse to one counter", () => {
  it("ignores workspace, duration and line numbers", () => {
    const a = ciFingerprint(failure(vitestRun("/w/run-1", "abc", 1243, 88)));
    const b = ciFingerprint(failure(vitestRun("/w/run-2", "abc", 985, 88)));
    expect(a).toBe(b);
  });

  // The direction that made M54 dead: an opaque token that changes every run
  // gave every run its own counter, so three strikes were never reached.
  it("ignores an opaque token the test prints, so the count actually accumulates", () => {
    const a = ciFingerprint(failure(vitestRun("/w/run-1", "x7hq2ktm91", 1243, 88)));
    const b = ciFingerprint(failure(vitestRun("/w/run-2", "p4vzb3ncw8", 985, 91)));
    expect(a).toBe(b);
  });

  it("ignores a uuid and a hex digest just the same", () => {
    const a = ciFingerprint(failure(vitestRun("/w/a", "7f1c2b90-4a1d-4a55-9f3e-0c9c8b7a6d54", 10, 1)));
    const b = ciFingerprint(failure(vitestRun("/w/b", "11111111-2222-4333-8444-555555555555", 20, 2)));
    expect(a).toBe(b);
  });

  it("ignores a temp directory that is regenerated per run", () => {
    const line = (dir: string): string => `Error: ENOENT: no such file, open '${dir}/fixtures/rates.json'`;
    expect(ciFingerprint(failure(line("/tmp/vitest-a1b2c3d4")))).toBe(
      ciFingerprint(failure(line("/tmp/vitest-9f8e7d6c"))),
    );
  });
});

describe("ciFingerprint — genuinely different failures keep separate counters", () => {
  // The direction that caused premature handover: every path collapsed to
  // `<path>`, so the failing test's own file stopped being part of its identity.
  it("keeps two different test FILES apart even when the test name matches", () => {
    const a = ciFingerprint(failure("FAIL src/pay/mapper.test.ts > maps null (12ms)"));
    const b = ciFingerprint(failure("FAIL src/auth/login.test.ts > maps null (12ms)"));
    expect(a).not.toBe(b);
  });

  it("keeps two different test NAMES in one file apart", () => {
    const a = ciFingerprint(failure("FAIL src/pay/mapper.test.ts > maps null"));
    const b = ciFingerprint(failure("FAIL src/pay/mapper.test.ts > rejects a negative amount"));
    expect(a).not.toBe(b);
  });

  it("keeps two different error classes apart", () => {
    const a = ciFingerprint(failure("TypeError: cannot read properties of undefined"));
    const b = ciFingerprint(failure("RangeError: cannot read properties of undefined"));
    expect(a).not.toBe(b);
  });

  it("keeps two different TypeScript diagnostics apart", () => {
    const a = ciFingerprint(failure("src/a.ts(12,5): error TS2345: argument of type X"));
    const b = ciFingerprint(failure("src/a.ts(12,5): error TS2551: argument of type X"));
    expect(a).not.toBe(b);
  });

  it("keeps a red lint apart from a red test that printed the same thing", () => {
    const a = ciFingerprint(failure("boom", { name: "lint" }));
    const b = ciFingerprint(failure("boom", { name: "test" }));
    expect(a).not.toBe(b);
  });

  it("keeps two different exit codes of one command apart", () => {
    expect(ciFingerprint(failure("boom", { exitCode: 1 }))).not.toBe(
      ciFingerprint(failure("boom", { exitCode: 2 })),
    );
  });
});

describe("ciFingerprint — shape", () => {
  it("is stable and short enough for a database key", () => {
    const fp = ciFingerprint(failure("boom"));
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(ciFingerprint(failure("boom"))).toBe(fp);
  });

  it("does not depend on the order the red commands came back in", () => {
    const lint: CiFailureInput = { name: "lint", exitCode: 1, output: "no-unused-vars" };
    const test: CiFailureInput = { name: "test", exitCode: 1, output: "TypeError: nope" };
    expect(ciFingerprint([lint, test])).toBe(ciFingerprint([test, lint]));
  });

  it("still produces a fingerprint when the output is empty", () => {
    expect(ciFingerprint(failure(""))).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("normalizeNoise", () => {
  it("keeps a path's basename so the failing file stays part of the identity", () => {
    expect(normalizeNoise("at /w/run-1/src/pay/mapper.ts:88:3")).toBe("at mapper.ts:<n>:<n>");
  });

  it("does not erase the error class while erasing opaque tokens", () => {
    const out = normalizeNoise("AssertionError in job k3ntx8qz91");
    expect(out).toContain("assertionerror");
    expect(out).toContain("<tok>");
  });

  it("keeps TypeScript diagnostic codes, which are the error's identity", () => {
    expect(normalizeNoise("error TS2345: bad argument")).toContain("error ts2345");
  });
});

describe("ciSignals", () => {
  it("reports what it considered the identity, for the handover note", () => {
    const signals = ciSignals("FAIL src/pay/mapper.test.ts > maps null\nTypeError: nope");
    expect(signals.some((s) => s.startsWith("test:"))).toBe(true);
    expect(signals).toContain("err:typeerror");
  });

  it("falls back to the normalised text rather than returning nothing", () => {
    expect(ciSignals("something entirely unstructured")).toEqual(["raw:something entirely unstructured"]);
  });
});
