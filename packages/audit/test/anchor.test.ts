import type { AuditEvent } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import {
  AUDIT_RETENTION_YEARS,
  AuditAnchor,
  AuditAnchorError,
  AuditChain,
  GENESIS,
  HmacAnchorSigner,
  InMemoryAuditStore,
  anchorPayload,
  buildAnchor,
  chainDigestOf,
  eventsOfDay,
  retentionExpiryOf,
  utcDayOf,
  verifyAnchor,
} from "../src/index.js";
import { clone, multiDayChain, sampleChain } from "./helpers.js";

const NOW = new Date("2026-08-08T23:59:59.000Z");
const signer = new HmacAnchorSigner("anchor-key-2026", "unit-test-anchor-secret");

describe("daily anchor (M33)", () => {
  it("summarises the day and signs the summary", async () => {
    const { events } = await sampleChain();
    const anchor = await buildAnchor({ events, signer, now: NOW, expectPrevHash: GENESIS });

    expect(AuditAnchor.safeParse(anchor).success).toBe(true);
    expect(anchor.day).toBe("2026-08-08");
    expect(anchor.firstSeq).toBe(1);
    expect(anchor.lastSeq).toBe(5);
    expect(anchor.eventCount).toBe(5);
    expect(anchor.prevHash).toBe("genesis");
    expect(anchor.headHash).toBe(events[4]!.hash);
    expect(anchor.chainDigest).toBe(chainDigestOf(events));
    expect(anchor.signature).toMatchObject({ alg: "hmac-sha256", keyId: "anchor-key-2026" });
  });

  it("is reproducible: same day, same records, same anchor", async () => {
    const { events } = await sampleChain();
    const first = await buildAnchor({ events, signer, now: NOW, expectPrevHash: GENESIS });
    const second = await buildAnchor({ events: clone(events), signer, now: NOW, expectPrevHash: GENESIS });
    expect(second).toEqual(first);
  });

  it("verifies against the records it covers", async () => {
    const { events } = await sampleChain();
    const anchor = await buildAnchor({ events, signer, now: NOW, expectPrevHash: GENESIS });

    expect(await verifyAnchor(anchor, signer, events)).toMatchObject({ ok: true, reasons: [] });
    expect((await verifyAnchor(anchor, signer)).ok).toBe(true);
  });

  it("catches an altered anchor", async () => {
    const { events } = await sampleChain();
    const anchor = await buildAnchor({ events, signer, now: NOW, expectPrevHash: GENESIS });

    const forged = { ...anchor, headHash: "a".repeat(64) };
    const result = await verifyAnchor(forged, signer, events);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/signature does not match/);
  });

  it("catches a rewritten chain that is internally consistent", async () => {
    const { events } = await sampleChain();
    const anchor = await buildAnchor({ events, signer, now: NOW, expectPrevHash: GENESIS });

    // The attack a hash chain alone cannot stop: rebuild the whole day so every
    // link recomputes. Yesterday's signed anchor is what exposes it.
    const { events: rewritten } = await sampleChain();
    const forgedDay = clone(rewritten);
    forgedDay[2] = { ...forgedDay[2]!, actor: "attacker@ugurbank.corp" };
    const resealed = await rebuild(forgedDay);

    const result = await verifyAnchor(anchor, signer, resealed);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/head hash differs|chain digest differs/);
    expect(result.chain?.ok).toBe(true); // the forged chain verifies on its own — that is the point
  });

  it("catches a truncated day", async () => {
    const { events } = await sampleChain();
    const anchor = await buildAnchor({ events, signer, now: NOW, expectPrevHash: GENESIS });

    const result = await verifyAnchor(anchor, signer, events.slice(0, 4));
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/covers 5 records, 4 supplied/);
  });

  it("rejects a signature made with another key", async () => {
    const { events } = await sampleChain();
    const anchor = await buildAnchor({ events, signer, now: NOW, expectPrevHash: GENESIS });
    const other = new HmacAnchorSigner("anchor-key-2026", "different-secret");

    expect((await verifyAnchor(anchor, other, events)).ok).toBe(false);
    const renamed = new HmacAnchorSigner("anchor-key-2027", "unit-test-anchor-secret");
    expect((await verifyAnchor(anchor, renamed, events)).reasons.join(" ")).toMatch(/verifier holds/);
  });

  it("refuses to anchor a broken chain", async () => {
    const { events } = await sampleChain();
    const broken = clone(events);
    broken[1] = { ...broken[1]!, subject: "UGURPAY-999" };

    await expect(buildAnchor({ events: broken, signer, now: NOW, expectPrevHash: GENESIS })).rejects.toThrow(AuditAnchorError);
    await expect(buildAnchor({ events: broken, signer, now: NOW, expectPrevHash: GENESIS })).rejects.toThrow(/first bad record is seq 2/);
  });

  it("refuses to sign a day whose first records were deleted (O2)", async () => {
    const { events } = await sampleChain();
    // Before this fix the expectation came from the day's own first record, so
    // a truncated day was signed without complaint — and the signature made the
    // truncation permanent evidence.
    const truncated = events.slice(1);

    await expect(
      buildAnchor({ events: truncated, signer, now: NOW, expectPrevHash: GENESIS }),
    ).rejects.toThrow(/chain_broken/);
    await expect(
      buildAnchor({ events: truncated, signer, now: NOW, expectPrevHash: GENESIS }),
    ).rejects.toThrow(/expected 1|expected genesis/);
  });

  it("refuses to continue a previous anchor without being told where it ended (O2)", async () => {
    const { days } = await multiDayChain();
    const secondDay = days[1]!;
    const previousHead = days[0]!.at(-1)!.hash;

    // A continuation anchor needs both halves of the expectation from outside.
    await expect(
      buildAnchor({ events: secondDay, signer, now: NOW, expectPrevHash: previousHead }),
    ).rejects.toThrow(/missing_expectation/);

    const anchor = await buildAnchor({
      events: secondDay,
      signer,
      now: NOW,
      expectPrevHash: previousHead,
      expectFirstSeq: days[0]!.length + 1,
    });
    expect(anchor.firstSeq).toBe(4);
    expect(anchor.prevHash).toBe(previousHead);

    // The same day, offered as if it continued a different head, is refused.
    await expect(
      buildAnchor({
        events: secondDay,
        signer,
        now: NOW,
        expectPrevHash: "c".repeat(64),
        expectFirstSeq: 4,
      }),
    ).rejects.toThrow(/chain_broken/);
  });

  it("refuses an empty day and a mixed-day slice", async () => {
    const { events } = await sampleChain();
    const { events: nextDay } = await sampleChain("2026-08-09T09:00:00.000Z");

    await expect(buildAnchor({ events: [], signer, now: NOW, expectPrevHash: GENESIS })).rejects.toThrow(/empty_day/);
    await expect(buildAnchor({ events: [...events, ...nextDay], signer, now: NOW, expectPrevHash: GENESIS })).rejects.toThrow(/mixed_days/);
  });

  it("rejects an anchor that is not an anchor", async () => {
    expect((await verifyAnchor({ day: "2026-08-08" }, signer)).ok).toBe(false);
    expect((await verifyAnchor(null, signer)).ok).toBe(false);
  });

  it("signs the canonical body, so key order in the anchor object is irrelevant", async () => {
    const { events } = await sampleChain();
    const anchor = await buildAnchor({ events, signer, now: NOW, expectPrevHash: GENESIS });
    const { signature: _signature, ...body } = anchor;
    const shuffled = Object.fromEntries(Object.entries(body).reverse());

    expect(anchorPayload(shuffled as typeof body)).toBe(anchorPayload(body));
    expect(await signer.verify(anchorPayload(shuffled as typeof body), anchor.signature.value)).toBe(true);
  });
});

describe("day selection and retention", () => {
  it("groups records by UTC day", async () => {
    const { events } = await sampleChain("2026-08-08T23:59:58.000Z");

    expect(utcDayOf("2026-08-08T23:59:58.000Z")).toBe("2026-08-08");
    expect(eventsOfDay(events, "2026-08-08").map((event) => event.seq)).toEqual([1, 2]);
    expect(eventsOfDay(events, "2026-08-09").map((event) => event.seq)).toEqual([3, 4, 5]);
    expect(() => eventsOfDay(events, "08-08-2026")).toThrow(AuditAnchorError);
  });

  it("keeps records for ten years (M56)", () => {
    expect(AUDIT_RETENTION_YEARS).toBe(10);
    expect(retentionExpiryOf("2026-08-08T09:00:00.000Z")).toBe("2036-08-08T09:00:00.000Z");
    expect(() => retentionExpiryOf("nope")).toThrow(AuditAnchorError);
  });
});

/** Re-seal a whole day after tampering — the "rewrite everything" attack. */
function rebuild(events: readonly AuditEvent[]): Promise<AuditEvent[]> {
  const chain = new AuditChain({ store: new InMemoryAuditStore() });
  return chain.appendMany(
    events.map((event) => ({
      actor: event.actor,
      action: event.action,
      subject: event.subject,
      meta: event.meta,
      at: event.at,
    })),
  );
}
