import type { AuditEvent } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import {
  buildAnchor,
  GENESIS,
  HmacAnchorSigner,
  verifyAnchor,
  verifyAnchorSeries,
  type AuditAnchor,
} from "../src/index.js";
import { multiDayChain, SAMPLE_DAYS } from "./helpers.js";

const NOW = new Date("2026-08-10T23:59:59.000Z");
const signer = new HmacAnchorSigner("anchor-key-2026", "unit-test-anchor-secret");

/** Anchor every supplied day, each one continuing the previous — the daily job (M33). */
async function anchorEachDay(days: readonly AuditEvent[][]): Promise<AuditAnchor[]> {
  const anchors: AuditAnchor[] = [];
  let expectPrevHash: string = GENESIS;
  let expectFirstSeq = 1;

  for (const events of days) {
    const anchor = await buildAnchor({ events, signer, now: NOW, expectPrevHash, expectFirstSeq });
    anchors.push(anchor);
    expectPrevHash = anchor.headHash;
    expectFirstSeq = anchor.lastSeq + 1;
  }
  return anchors;
}

describe("anchor series (M33)", () => {
  it("accepts a series where every anchor continues the previous one", async () => {
    const { days } = await multiDayChain();
    const anchors = await anchorEachDay(days);

    const result = await verifyAnchorSeries(anchors, signer);
    expect(result.reasons).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(3);
    expect(result.headHash).toBe(days[2]!.at(-1)!.hash);
    expect(result.lastSeq).toBe(9);
  });

  it("catches a WHOLE DAY deleted, which each anchor alone reports as fine (O1)", async () => {
    const { days } = await multiDayChain();
    const anchors = await anchorEachDay(days);

    // Day 2 and its anchor are gone. Both survivors still verify on their own —
    // that is precisely the gap a per-anchor check leaves open.
    expect((await verifyAnchor(anchors[0]!, signer, days[0]!)).ok).toBe(true);
    expect((await verifyAnchor(anchors[2]!, signer, days[2]!)).ok).toBe(true);

    const result = await verifyAnchorSeries([anchors[0]!, anchors[2]!], signer);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/a whole day is missing or was replaced/);
    expect(result.reasons.join(" ")).toMatch(/starts at seq 7, but 2026-08-08 ended at 3/);
    expect(result.headHash).toBeNull();
  });

  it("catches a series that does not start at genesis", async () => {
    const { days } = await multiDayChain();
    const anchors = await anchorEachDay(days);

    const result = await verifyAnchorSeries(anchors.slice(1), signer);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/series starts at seq 4, expected 1/);
    expect(result.reasons.join(" ")).toMatch(new RegExp(`expected ${GENESIS}`));

    // With the archived head supplied from outside, the same slice verifies.
    const continued = await verifyAnchorSeries(anchors.slice(1), signer, {
      firstSeq: anchors[0]!.lastSeq + 1,
      prevHash: anchors[0]!.headHash,
    });
    expect(continued.ok).toBe(true);
  });

  it("catches days offered out of order", async () => {
    const { days } = await multiDayChain();
    const anchors = await anchorEachDay(days);

    const result = await verifyAnchorSeries([anchors[0]!, anchors[2]!, anchors[1]!], signer);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/day 2026-08-09 does not follow 2026-08-10/);
  });

  it("catches an anchor whose eventCount does not match the range it claims", async () => {
    const { days } = await multiDayChain();
    const anchors = await anchorEachDay(days);
    const forged = { ...anchors[1]!, eventCount: 2 };

    const result = await verifyAnchorSeries([anchors[0]!, forged, anchors[2]!], signer);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/claims eventCount 2/);
    // Re-signing the forgery does not help: the seq link to day 3 still breaks.
    expect(result.reasons.join(" ")).toMatch(/signature does not match/);
  });

  it("checks every signature and reports the anchor by position", async () => {
    const { days } = await multiDayChain();
    const anchors = await anchorEachDay(days);
    const other = new HmacAnchorSigner("anchor-key-2026", "different-secret");

    const result = await verifyAnchorSeries(anchors, other);
    expect(result.ok).toBe(false);
    expect(result.anchors).toHaveLength(3);
    expect(result.reasons.every((reason) => /^anchor \d/.test(reason))).toBe(true);
  });

  it("refuses an empty series and an unreadable anchor", async () => {
    const { days } = await multiDayChain();
    const anchors = await anchorEachDay(days);

    const empty = await verifyAnchorSeries([], signer);
    expect(empty.ok).toBe(false);
    expect(empty.checked).toBe(0);
    expect(empty.reasons.join(" ")).toMatch(/empty series proves nothing/);

    const broken = await verifyAnchorSeries([anchors[0]!, { day: SAMPLE_DAYS[1] }, anchors[2]!], signer);
    expect(broken.ok).toBe(false);
    expect(broken.reasons.join(" ")).toMatch(/anchor 1: anchor does not match its schema/);
  });
});
