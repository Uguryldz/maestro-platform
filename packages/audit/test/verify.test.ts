import { describe, expect, it } from "vitest";
import { GENESIS, verifyChain } from "../src/index.js";
import { clone, sampleChain } from "./helpers.js";

/**
 * The evidence an audit team is shown: the three ways a chain can be attacked,
 * each caught, each naming the record where the trail stops being trustworthy.
 */
describe("verifyChain", () => {
  it("accepts an untouched chain and reports its head", async () => {
    const { events } = await sampleChain();
    const result = verifyChain(events);

    expect(result.ok).toBe(true);
    expect(result.checked).toBe(5);
    expect(result.firstBadSeq).toBeNull();
    expect(result.headHash).toBe(events[4]!.hash);
    expect(result.issues).toEqual([]);
  });

  it("catches a TAMPERED record and names its seq", async () => {
    const { events } = await sampleChain();
    const tampered = clone(events);
    // The classic forgery: change who approved the gate, leave the hash alone.
    tampered[2] = { ...tampered[2]!, actor: "attacker@ugurbank.corp" };

    const result = verifyChain(tampered);

    expect(result.ok).toBe(false);
    expect(result.firstBadSeq).toBe(3);
    expect(result.issues.map((issue) => issue.kind)).toContain("hash_mismatch");
    expect(result.headHash).toBeNull();
    expect(result.issues[0]!.detail).toMatch(/the record was altered/);
  });

  it("catches a tampered meta field, even one added key", async () => {
    const { events } = await sampleChain();
    const tampered = clone(events);
    tampered[1] = { ...tampered[1]!, meta: { ...tampered[1]!.meta, approvedBy: "nobody" } };

    const result = verifyChain(tampered);
    expect(result.ok).toBe(false);
    expect(result.firstBadSeq).toBe(2);
  });

  it("catches a DELETED record — the link breaks and the sequence skips", async () => {
    const { events } = await sampleChain();
    const shortened = clone(events).filter((event) => event.seq !== 3);

    const result = verifyChain(shortened);

    expect(result.ok).toBe(false);
    expect(result.checked).toBe(4);
    expect(result.firstBadSeq).toBe(3);
    const kinds = result.issues.map((issue) => issue.kind);
    expect(kinds).toContain("sequence_gap");
    expect(kinds).toContain("prev_hash_mismatch");
    expect(result.issues.find((issue) => issue.kind === "sequence_gap")!.detail).toMatch(/1 record\(s\) missing/);
  });

  it("catches deletion of the first record", async () => {
    const { events } = await sampleChain();
    const result = verifyChain(clone(events).slice(1));

    expect(result.ok).toBe(false);
    expect(result.firstBadSeq).toBe(2);
    expect(result.issues.map((issue) => issue.kind)).toContain("bad_start");
    expect(result.issues.map((issue) => issue.detail).join(" ")).toMatch(/expected 1/);
  });

  it("catches deletion of the last record when the expected head is known", async () => {
    const { events } = await sampleChain();
    const truncated = clone(events).slice(0, 4);

    // The chain still verifies on its own — truncation is only detectable
    // against a head recorded elsewhere, which is exactly why anchors exist.
    expect(verifyChain(truncated).ok).toBe(true);
    expect(verifyChain(truncated).headHash).not.toBe(events[4]!.hash);
  });

  it("catches REORDERED records", async () => {
    const { events } = await sampleChain();
    const swapped = clone(events);
    [swapped[1], swapped[2]] = [swapped[2]!, swapped[1]!];

    const result = verifyChain(swapped);

    expect(result.ok).toBe(false);
    expect(result.firstBadSeq).toBe(2);
    const kinds = result.issues.map((issue) => issue.kind);
    expect(kinds).toContain("out_of_order");
    expect(kinds).toContain("prev_hash_mismatch");
  });

  it("catches a duplicated record", async () => {
    const { events } = await sampleChain();
    const duplicated = clone(events);
    duplicated.splice(2, 0, structuredClone(events[1]!));

    const result = verifyChain(duplicated);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.kind)).toContain("out_of_order");
  });

  it("catches a record swapped in from another chain (valid on its own, wrong link)", async () => {
    const { events } = await sampleChain();
    const { events: other } = await sampleChain("2026-08-09T09:00:00.000Z");
    const spliced = clone(events);
    spliced[3] = structuredClone(other[3]!);

    const result = verifyChain(spliced);
    expect(result.ok).toBe(false);
    expect(result.firstBadSeq).toBe(4);
    expect(result.issues.map((issue) => issue.kind)).toContain("prev_hash_mismatch");
  });

  it("catches a record that is not an AuditEvent at all", () => {
    const result = verifyChain([{ seq: 1, actor: "maestro-worker" }, null]);

    expect(result.ok).toBe(false);
    expect(result.checked).toBe(2);
    expect(result.issues.map((issue) => issue.kind)).toEqual(["schema_invalid", "schema_invalid"]);
    expect(result.issues[1]!.seq).toBeNull();
  });

  it("verifies a slice against the link it is expected to continue", async () => {
    const { events } = await sampleChain();
    const slice = events.slice(2);

    expect(verifyChain(slice).ok).toBe(false); // no context: looks like a bad start
    expect(verifyChain(slice, { expectFirstSeq: 3, expectPrevHash: events[1]!.hash }).ok).toBe(true);
    expect(verifyChain(slice, { expectFirstSeq: 3, expectPrevHash: "f".repeat(64) }).ok).toBe(false);
  });

  it("refuses an empty input — emptiness proves nothing (O3)", () => {
    const result = verifyChain([]);

    // Every caller writes `if (result.ok)`. An emptied table must not pass.
    expect(result.ok).toBe(false);
    expect(result.checked).toBe(0);
    expect(result.headHash).toBeNull();
    expect(result.issues.map((issue) => issue.kind)).toEqual(["empty"]);
    expect(result.issues[0]!.detail).toMatch(/proves nothing/);
  });

  it("keeps checking the record that FOLLOWS an unreadable one (D5)", async () => {
    const { events } = await sampleChain();
    const { events: other } = await sampleChain("2026-08-09T09:00:00.000Z");

    // seq 2 is corrupted beyond the schema, and seq 3 was swapped in from
    // another chain. Dropping the link state at the unreadable record made the
    // very next record unchecked — the damage report stopped one row short.
    const damaged: unknown[] = clone(events);
    damaged[1] = { ...events[1]!, action: "NOT_AN_ACTION" };
    damaged[2] = structuredClone(other[2]!);

    const result = verifyChain(damaged);
    expect(result.ok).toBe(false);
    expect(result.checked).toBe(5);
    expect(result.issues.map((issue) => issue.kind)).toContain("schema_invalid");
    expect(
      result.issues.filter((issue) => issue.kind === "prev_hash_mismatch").map((issue) => issue.seq),
    ).toEqual([3, 4]);
    expect(result.firstBadSeq).toBe(2);
  });

  it("reports the gap when records are deleted right after an unreadable one (D5)", async () => {
    const { events } = await sampleChain();
    const damaged: unknown[] = [
      events[0]!,
      { ...events[1]!, action: "NOT_AN_ACTION" },
      // seq 3 deleted.
      events[3]!,
      events[4]!,
    ];

    const result = verifyChain(damaged);
    const kinds = result.issues.map((issue) => issue.kind);

    expect(result.ok).toBe(false);
    expect(kinds).toContain("sequence_gap");
    expect(kinds).toContain("prev_hash_mismatch");
    expect(result.issues.find((issue) => issue.kind === "sequence_gap")!.detail).toMatch(
      /seq jumps from 2 to 4/,
    );
  });

  it("rejects a forged genesis link", async () => {
    const { events } = await sampleChain();
    const forged = clone(events);
    forged[0] = { ...forged[0]!, prevHash: "0".repeat(64) };

    const result = verifyChain(forged);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.detail).join(" ")).toMatch(new RegExp(`expected ${GENESIS}`));
  });
});
