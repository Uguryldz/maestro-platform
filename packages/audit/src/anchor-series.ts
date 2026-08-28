import { AuditAnchor, verifyAnchor, type AnchorSigner, type AnchorVerification } from "./anchor.js";
import { GENESIS } from "./hash.js";

/**
 * Anchors verified one by one cover "the whole day was rewritten" but not "the
 * whole day was deleted": with day 2 gone, day 1 and day 3 each still verify on
 * their own, and nothing in either anchor mentions the missing day. The series
 * closes that — each anchor must continue the previous one:
 *
 *   anchor[i].prevHash  === anchor[i-1].headHash
 *   anchor[i].firstSeq  === anchor[i-1].lastSeq + 1
 *   anchor[i].day        >  anchor[i-1].day
 *
 * Removing a day breaks both links, and re-signing the survivors does not help:
 * the anchors are signed somewhere the database owner does not control (M5/M57).
 */

export interface AnchorSeriesStart {
  /** `firstSeq` the oldest anchor must declare. */
  readonly firstSeq: number;
  /** `prevHash` the oldest anchor must declare. */
  readonly prevHash: string;
}

export interface AnchorSeriesVerification {
  readonly ok: boolean;
  readonly reasons: readonly string[];
  /** Number of anchors inspected. Zero is never `ok`. */
  readonly checked: number;
  /** Per-anchor signature results, in the order supplied. */
  readonly anchors: readonly AnchorVerification[];
  /** Chain head the series proves, when the whole series verified. */
  readonly headHash: string | null;
  /** Highest `lastSeq` the series proves, when the whole series verified. */
  readonly lastSeq: number | null;
}

/**
 * Verify a run of daily anchors as one linked series. Each anchor's signature is
 * checked with `verifyAnchor` (records are not needed — the anchors are the
 * evidence here), then the links between them.
 *
 * `start` defaults to the beginning of the chain: seq 1 pointing at genesis.
 * Pass it only when the series deliberately begins later (an archived head).
 */
export async function verifyAnchorSeries(
  anchors: readonly unknown[],
  signer: AnchorSigner,
  start: AnchorSeriesStart = { firstSeq: 1, prevHash: GENESIS },
): Promise<AnchorSeriesVerification> {
  const reasons: string[] = [];
  const results: AnchorVerification[] = [];

  if (anchors.length === 0) {
    return {
      ok: false,
      reasons: ["no anchors were supplied — an empty series proves nothing about the chain"],
      checked: 0,
      anchors: [],
      headHash: null,
      lastSeq: null,
    };
  }

  let previous: AuditAnchor | null = null;

  for (const [index, candidate] of anchors.entries()) {
    const result = await verifyAnchor(candidate, signer);
    results.push(result);
    reasons.push(...result.reasons.map((reason) => `anchor ${index}: ${reason}`));

    const parsed = AuditAnchor.safeParse(candidate);
    if (!parsed.success) {
      // Unreadable anchor: the link to the next one cannot be checked, and the
      // series is already not ok.
      previous = null;
      continue;
    }
    const anchor = parsed.data;

    reasons.push(...selfConsistency(anchor, index));
    if (index === 0) {
      reasons.push(...startLinks(anchor, start));
    } else if (previous !== null) {
      reasons.push(...seriesLinks(anchor, previous, index));
    }

    previous = anchor;
  }

  const ok = reasons.length === 0;
  return {
    ok,
    reasons,
    checked: anchors.length,
    anchors: results,
    headHash: ok && previous ? previous.headHash : null,
    lastSeq: ok && previous ? previous.lastSeq : null,
  };
}

/** A day is a contiguous slice of the chain, so its record count is fixed by its bounds. */
function selfConsistency(anchor: AuditAnchor, index: number): string[] {
  const span = anchor.lastSeq - anchor.firstSeq + 1;
  if (anchor.lastSeq < anchor.firstSeq) {
    return [`anchor ${index} (${anchor.day}): lastSeq ${anchor.lastSeq} is before firstSeq ${anchor.firstSeq}`];
  }
  if (anchor.eventCount !== span) {
    return [
      `anchor ${index} (${anchor.day}): covers seq ${anchor.firstSeq}-${anchor.lastSeq} (${span} records) but claims eventCount ${anchor.eventCount}`,
    ];
  }
  return [];
}

function startLinks(anchor: AuditAnchor, start: AnchorSeriesStart): string[] {
  const reasons: string[] = [];
  if (anchor.prevHash !== start.prevHash) {
    reasons.push(`anchor 0 (${anchor.day}): series starts at ${anchor.prevHash}, expected ${start.prevHash}`);
  }
  if (anchor.firstSeq !== start.firstSeq) {
    reasons.push(`anchor 0 (${anchor.day}): series starts at seq ${anchor.firstSeq}, expected ${start.firstSeq}`);
  }
  return reasons;
}

function seriesLinks(anchor: AuditAnchor, previous: AuditAnchor, index: number): string[] {
  const reasons: string[] = [];
  if (anchor.day <= previous.day) {
    reasons.push(`anchor ${index}: day ${anchor.day} does not follow ${previous.day}`);
  }
  if (anchor.prevHash !== previous.headHash) {
    reasons.push(
      `anchor ${index} (${anchor.day}): prevHash ${anchor.prevHash} does not continue ${previous.day} (head ${previous.headHash}) — a whole day is missing or was replaced`,
    );
  }
  if (anchor.firstSeq !== previous.lastSeq + 1) {
    reasons.push(
      `anchor ${index} (${anchor.day}): starts at seq ${anchor.firstSeq}, but ${previous.day} ended at ${previous.lastSeq}`,
    );
  }
  return reasons;
}
