import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GENESIS, chainInput, computeEventHash, rehash, sealEvent, type AuditEventCore } from "../src/index.js";

const CORE: AuditEventCore = {
  seq: 1,
  at: "2026-08-08T09:00:00.000Z",
  actor: "maestro-worker",
  action: "RUN_STARTED",
  subject: "UGURPAY-101",
  prevHash: GENESIS,
  meta: { runId: "run-0001", risk: "orta" },
};

describe("chain input", () => {
  it("is the documented seven-field pipe-joined string", () => {
    expect(chainInput(CORE)).toBe(
      '1|2026-08-08T09:00:00.000Z|"maestro-worker"|RUN_STARTED|"UGURPAY-101"|genesis|{"risk":"orta","runId":"run-0001"}',
    );
  });

  it("hashes to sha256 of exactly that string", () => {
    const expected = createHash("sha256").update(chainInput(CORE), "utf8").digest("hex");
    expect(computeEventHash(CORE)).toBe(expected);
    expect(computeEventHash(CORE)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("event hashing", () => {
  it("gives the same hash for the same event every time", () => {
    const hashes = new Set(Array.from({ length: 25 }, () => computeEventHash(CORE)));
    expect(hashes.size).toBe(1);
  });

  it("ignores the key order the caller happened to use for meta", () => {
    const reordered: AuditEventCore = { ...CORE, meta: { risk: "orta", runId: "run-0001" } };
    expect(computeEventHash(reordered)).toBe(computeEventHash(CORE));
  });

  it("changes when any single field changes", () => {
    const base = computeEventHash(CORE);
    const variants: AuditEventCore[] = [
      { ...CORE, seq: 2 },
      { ...CORE, at: "2026-08-08T09:00:00.001Z" },
      { ...CORE, actor: "maestro-runner" },
      { ...CORE, action: "RUN_CLOSED" },
      { ...CORE, subject: "UGURPAY-102" },
      { ...CORE, prevHash: "a".repeat(64) },
      { ...CORE, meta: { runId: "run-0001", risk: "kritik" } },
      { ...CORE, meta: {} },
    ];
    for (const variant of variants) {
      expect(computeEventHash(variant)).not.toBe(base);
    }
  });

  it("cannot be fooled by moving a pipe between fields", () => {
    const left = computeEventHash({ ...CORE, actor: "a|b@corp", subject: "c" });
    const right = computeEventHash({ ...CORE, actor: "a", subject: "b@corp|c" });
    expect(left).not.toBe(right);
  });
});

describe("sealEvent", () => {
  it("returns a contract-valid event carrying its own hash", () => {
    const event = sealEvent(CORE);
    expect(event.hash).toBe(computeEventHash(CORE));
    expect(rehash(event)).toBe(event.hash);
    expect(event.prevHash).toBe(GENESIS);
  });

  it("refuses a record that violates the AuditEvent contract", () => {
    expect(() => sealEvent({ ...CORE, seq: 0 })).toThrow();
    expect(() => sealEvent({ ...CORE, subject: "" })).toThrow();
    expect(() => sealEvent({ ...CORE, at: "08.08.2026" })).toThrow();
  });
});
