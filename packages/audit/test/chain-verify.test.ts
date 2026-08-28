import type { AuditEvent } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import {
  AuditChain,
  AuditChainError,
  GENESIS,
  InMemoryAuditStore,
  sealEvent,
  type AuditStore,
} from "../src/index.js";
import { fixedClock, SAMPLE_INPUTS, sampleChain } from "./helpers.js";

/**
 * These tests deliberately go through `AuditChain.verify()` — the method the
 * worker and the audit screen call — and not through the pure `verifyChain`.
 *
 * The finding that produced them was exactly this gap: `verifyChain` proved
 * every tampering claim, while the production entry point took the expected
 * start from the first record it happened to read. An attacker who deletes
 * records controls that record, so the verifier asked the suspect what the
 * truth was and believed the answer.
 */

/** A store the attacker owns: it returns whatever the test hands it. */
class TamperedStore implements AuditStore {
  constructor(private readonly rows: AuditEvent[]) {}

  head(): Promise<AuditEvent | null> {
    return Promise.resolve(this.rows.at(-1) ?? null);
  }

  append(event: AuditEvent): Promise<void> {
    this.rows.push(event);
    return Promise.resolve();
  }

  read(range?: { fromSeq?: number; toSeq?: number }): Promise<AuditEvent[]> {
    const from = range?.fromSeq ?? Number.NEGATIVE_INFINITY;
    const to = range?.toSeq ?? Number.POSITIVE_INFINITY;
    return Promise.resolve(this.rows.filter((row) => row.seq >= from && row.seq <= to));
  }
}

const chainOver = (rows: AuditEvent[]): AuditChain => new AuditChain({ store: new TamperedStore(rows) });

describe("AuditChain.verify — the expectation never comes from the records (K1)", () => {
  it("verifies an untouched chain and reports its head", async () => {
    const { chain, events } = await sampleChain();
    const result = await chain.verify();

    expect(result.ok).toBe(true);
    expect(result.checked).toBe(5);
    expect(result.headHash).toBe(events[4]!.hash);
  });

  it("REFUSES a chain whose first records were deleted", async () => {
    const { events } = await sampleChain();
    const result = await chainOver(events.slice(2)).verify();

    expect(result.ok).toBe(false);
    expect(result.checked).toBe(3);
    expect(result.issues.map((issue) => issue.kind)).toContain("bad_start");
    expect(result.issues.map((issue) => issue.detail).join(" ")).toMatch(/expected 1/);
    expect(result.issues.map((issue) => issue.detail).join(" ")).toMatch(new RegExp(`expected ${GENESIS}`));
  });

  it("REFUSES an emptied table instead of reporting checked: 0, ok: true", async () => {
    const result = await chainOver([]).verify();

    expect(result.ok).toBe(false);
    expect(result.checked).toBe(0);
    expect(result.headHash).toBeNull();
    expect(result.issues.map((issue) => issue.kind)).toEqual(["empty"]);
  });

  it("REFUSES a chain re-sealed from a forged genesis", async () => {
    // The whole table rewritten from scratch, self-consistent, but starting from
    // a fabricated predecessor instead of the genesis marker.
    const forged: AuditEvent[] = [];
    let prevHash: string = "9".repeat(64);
    SAMPLE_INPUTS.forEach((input, index) => {
      const event = sealEvent({
        seq: index + 1,
        at: `2026-08-08T09:00:0${index}.000Z`,
        actor: input.actor,
        action: input.action,
        subject: input.subject,
        prevHash,
        meta: input.meta ?? {},
      });
      forged.push(event);
      prevHash = event.hash;
    });

    const result = await chainOver(forged).verify();
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.kind)).toContain("bad_start");
    expect(result.firstBadSeq).toBe(1);
  });

  it("REFUSES a slice that carries no expectation from outside the database", async () => {
    const { chain } = await sampleChain();

    await expect(chain.verify({ fromSeq: 3 })).rejects.toThrow(AuditChainError);
    await expect(chain.verify({ fromSeq: 3 })).rejects.toThrow(/expectPrevHash from a signed anchor/);
  });

  it("verifies a slice against an expectation the caller supplies (an anchor's headHash)", async () => {
    const { chain, events } = await sampleChain();

    const good = await chain.verify({ fromSeq: 3, expectPrevHash: events[1]!.hash });
    expect(good.ok).toBe(true);
    expect(good.checked).toBe(3);

    const wrong = await chain.verify({ fromSeq: 3, expectPrevHash: "f".repeat(64) });
    expect(wrong.ok).toBe(false);
    expect(wrong.issues.map((issue) => issue.kind)).toContain("bad_start");
  });

  it("refuses a whole-chain verification that is handed a non-genesis expectation", async () => {
    const { chain } = await sampleChain();
    await expect(chain.verify({ expectPrevHash: "a".repeat(64) })).rejects.toThrow(/must expect genesis/);
    await expect(chain.verify({ fromSeq: 1, expectPrevHash: "a".repeat(64) })).rejects.toThrow(AuditChainError);
  });

  it("still finds tampering in the middle of the chain", async () => {
    const { events } = await sampleChain();
    const tampered = events.map((event, index) =>
      index === 2 ? { ...event, actor: "attacker@ugurbank.corp" } : event,
    );

    const result = await chainOver(tampered).verify();
    expect(result.ok).toBe(false);
    expect(result.firstBadSeq).toBe(3);
  });

  it("verifies an upper-bounded slice from genesis without an extra expectation", async () => {
    const store = new InMemoryAuditStore();
    const chain = new AuditChain({ store, clock: fixedClock("2026-08-08T09:00:00.000Z") });
    await chain.appendMany(SAMPLE_INPUTS);

    const result = await chain.verify({ toSeq: 3 });
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(3);
  });
});
