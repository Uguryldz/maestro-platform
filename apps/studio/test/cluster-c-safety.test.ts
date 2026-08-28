import { describe, expect, it } from "vitest";
import { assess, type ChainVerification } from "../src/screens/audit/verification.ts";
import {
  isVisibleInChannel,
  partitionByDataClass,
  resolveDataClass,
} from "../src/screens/knowledge/classify.ts";
import { outcomeTone, poolOutcome, toOutcome } from "../src/screens/shared/outcome.ts";
import { bySeverity, severityRank, severityTone, toSeverity } from "../src/screens/shared/severity.ts";

describe("knowledge data-class handling (fail closed)", () => {
  it("treats an untagged record as confidential, NOT public", () => {
    expect(resolveDataClass(undefined)).toBe("gizli");
    expect(resolveDataClass(null)).toBe("gizli");
    expect(resolveDataClass("")).toBe("gizli");
  });

  it("treats an unrecognised label as confidential", () => {
    expect(resolveDataClass("public")).toBe("gizli");
    expect(resolveDataClass("AÇIK")).toBe("gizli");
    expect(resolveDataClass(42)).toBe("gizli");
  });

  it("passes through the three known classes", () => {
    expect(resolveDataClass("acik")).toBe("acik");
    expect(resolveDataClass("dahili")).toBe("dahili");
    expect(resolveDataClass("gizli")).toBe("gizli");
  });

  it("drops confidential and untagged records from this channel", () => {
    expect(isVisibleInChannel("acik")).toBe(true);
    expect(isVisibleInChannel("dahili")).toBe(true);
    expect(isVisibleInChannel("gizli")).toBe(false);
    expect(isVisibleInChannel(undefined)).toBe(false);
  });

  it("counts what it withheld instead of hiding the omission", () => {
    const { visible, withheld } = partitionByDataClass([
      { docId: "1", dataClass: "acik" },
      { docId: "2", dataClass: "gizli" },
      { docId: "3" },
      { docId: "4", dataClass: "dahili" },
    ]);
    expect(visible.map((d) => d.docId)).toEqual(["1", "4"]);
    expect(withheld).toBe(2);
  });
});

describe("audit chain assessment (does not trust the record's own claim)", () => {
  const base: ChainVerification = { ok: true, checked: 81_422, brokenAtSeq: null };

  it("accepts a pass that actually re-hashed records", () => {
    expect(assess(base).assessment).toBe("consistent");
    expect(assess(base).tone).toBe("green");
  });

  it("refuses to show a bare ok as a pass when nothing was re-hashed", () => {
    const result = assess({ ...base, checked: 0 });
    expect(result.assessment).toBe("unsubstantiated");
    expect(result.tone).not.toBe("green");
    expect(result.basis).toContain("audit.basis.nothing_rehashed");
  });

  it("never claims tamper-proofing: the missing anchor is always stated", () => {
    // Recomputation shows internal consistency only — a wholesale rewrite would
    // recompute the hashes too. The screen must say so even on a green result.
    expect(assess(base).basis).toContain("audit.basis.no_anchor");
    expect(assess({ ...base, checked: 0 }).basis).toContain("audit.basis.no_anchor");
  });

  it("surfaces a broken chain even when the server claims ok", () => {
    const result = assess({ ...base, ok: true, brokenAtSeq: 42 });
    expect(result.assessment).toBe("broken");
    expect(result.tone).toBe("red");
  });

  it("never softens an explicit failure", () => {
    expect(assess({ ...base, ok: false }).assessment).toBe("broken");
    expect(assess({ ...base, ok: false }).tone).toBe("red");
  });

  it("reports 'not run' when there is no result yet", () => {
    expect(assess(undefined).assessment).toBe("not_run");
    expect(assess(undefined).tone).toBe("gray");
  });

  it("always states what the verdict rests on", () => {
    expect(assess(base).basis.length).toBeGreaterThan(0);
    expect(assess(undefined).basis.length).toBeGreaterThan(0);
  });
});

describe("severity ordering (nothing hidden, unknown does not sink)", () => {
  it("normalises unknown severities instead of dropping them", () => {
    expect(toSeverity("weird")).toBe("unknown");
    expect(toSeverity(undefined)).toBe("unknown");
    expect(toSeverity("CRITICAL")).toBe("critical");
  });

  it("ranks an unclassified finding above low, not below it", () => {
    expect(severityRank("unknown")).toBeLessThan(severityRank("low"));
    expect(severityRank("critical")).toBeLessThan(severityRank("high"));
  });

  it("sorts most severe first and keeps every row", () => {
    const rows = [
      { id: "a", sev: "low" },
      { id: "b", sev: "critical" },
      { id: "c", sev: "nonsense" },
      { id: "d", sev: "medium" },
      { id: "e", sev: "high" },
    ];
    const sorted = bySeverity(rows, (r) => r.sev);
    expect(sorted.map((r) => r.id)).toEqual(["b", "e", "d", "c", "a"]);
    expect(sorted).toHaveLength(rows.length);
  });

  it("does not mutate the input array", () => {
    const rows = [{ sev: "low" }, { sev: "critical" }];
    bySeverity(rows, (r) => r.sev);
    expect(rows[0]?.sev).toBe("low");
  });

  it("gives critical and low visually distinct tones", () => {
    expect(severityTone("critical")).not.toBe(severityTone("low"));
    expect(severityTone("critical")).toBe("red");
  });
});

describe("llm outcome vocabulary", () => {
  it("passes through the four known outcomes", () => {
    expect(toOutcome("ok")).toBe("ok");
    expect(toOutcome("queued")).toBe("queued");
    expect(toOutcome("degraded")).toBe("degraded");
    expect(toOutcome("blocked")).toBe("blocked");
  });

  it("fails closed to blocked for anything unrecognised", () => {
    expect(toOutcome("fine")).toBe("blocked");
    expect(toOutcome(undefined)).toBe("blocked");
  });

  it("never paints queued or degraded as success green", () => {
    expect(outcomeTone("ok")).toBe("green");
    expect(outcomeTone("queued")).not.toBe("green");
    expect(outcomeTone("degraded")).not.toBe("green");
    expect(outcomeTone("blocked")).not.toBe("green");
  });

  it("maps an exhausted pool to queued, not to a failure", () => {
    // Quota running out parks work; it does not lose it.
    expect(poolOutcome(false)).toBe("queued");
    expect(poolOutcome(true)).toBe("ok");
  });

  it("does not render an unknown pool as a green light", () => {
    expect(poolOutcome(undefined)).not.toBe("ok");
    expect(outcomeTone(poolOutcome(undefined))).not.toBe("green");
  });
});
