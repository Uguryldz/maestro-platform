import { AuditEvent } from "@maestro/contracts";
import { GENESIS, rehash } from "./hash.js";

/**
 * What went wrong, and where. `seq` is the sequence number of the record the
 * finding is about (or the expected one for a gap), because "the chain is
 * broken" is useless to an auditor — "record 412 was altered" is evidence.
 */
export type ChainIssueKind =
  /** The record does not match the AuditEvent contract at all. */
  | "schema_invalid"
  /** Stored hash ≠ hash recomputed from the record's own fields → the record was altered. */
  | "hash_mismatch"
  /** `prevHash` does not point at the previous record's hash → a record was removed or swapped. */
  | "prev_hash_mismatch"
  /** Sequence numbers skip → a record was deleted. */
  | "sequence_gap"
  /** Sequence numbers go backwards or repeat → records were reordered or duplicated. */
  | "out_of_order"
  /** The first record does not start the chain the way it was expected to. */
  | "bad_start"
  /** Nothing was verified. An emptied table must never report `ok`. */
  | "empty";

export interface ChainIssue {
  readonly kind: ChainIssueKind;
  /** Sequence number the finding concerns; `null` when the record is too broken to read one. */
  readonly seq: number | null;
  /** Zero-based position in the array that was verified. */
  readonly index: number;
  readonly detail: string;
}

export interface ChainVerification {
  /** True only when at least one record was inspected and nothing was found. */
  readonly ok: boolean;
  /** Number of records inspected. Zero is never `ok`: emptiness proves nothing. */
  readonly checked: number;
  /** Lowest `seq` with a finding; the record an investigation starts from. */
  readonly firstBadSeq: number | null;
  /** Hash of the last record, when the whole slice verified. */
  readonly headHash: string | null;
  readonly issues: readonly ChainIssue[];
}

export interface VerifyOptions {
  /**
   * Expected `seq` of the first record. Defaults to 1 (the whole chain).
   * It must come from *outside* the records — a signed anchor, the caller's
   * own query bounds — never from the first record on hand, which is the value
   * an attacker who deleted the records before it controls.
   */
  readonly expectFirstSeq?: number;
  /** Expected `prevHash` of the first record. Defaults to `"genesis"`. Same rule. */
  readonly expectPrevHash?: string;
}

/**
 * What the next record must continue from. Salvaged best-effort even when the
 * predecessor failed the schema, so one unreadable row does not blind the rest
 * of the damage report.
 */
interface Link {
  readonly seq: number;
  /** `null` when the predecessor's hash could not be read — the link is unverifiable, not ok. */
  readonly hash: string | null;
}

/**
 * Verify a chain, or a contiguous slice of one, from the records alone — no
 * database, no side state. Three attacks are detected by construction:
 *
 *  · altering a record  → its recomputed hash no longer matches (`hash_mismatch`);
 *  · deleting a record  → the next record's `prevHash` points at a hash that is
 *    no longer there and the sequence skips (`prev_hash_mismatch` + `sequence_gap`);
 *  · reordering records → `out_of_order` plus a broken link.
 *
 * All findings are collected (an auditor wants the full damage report), and
 * `firstBadSeq` names where the trail stops being trustworthy.
 *
 * The expected start is a *parameter*, never something read off the records:
 * an attacker who deletes the head of the chain also controls what the
 * remaining first record claims. Callers that hold no external expectation get
 * the only trustworthy default — seq 1 pointing at genesis.
 */
export function verifyChain(events: readonly unknown[], options: VerifyOptions = {}): ChainVerification {
  const issues: ChainIssue[] = [];
  const expectFirstSeq = options.expectFirstSeq ?? 1;
  const expectPrevHash = options.expectPrevHash ?? GENESIS;

  let previous: Link | null = null;
  let headHash: string | null = null;
  let index = 0;

  for (const candidate of events) {
    const parsed = AuditEvent.safeParse(candidate);
    if (!parsed.success) {
      const seq = readSeq(candidate);
      issues.push({
        kind: "schema_invalid",
        seq,
        index,
        detail: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; "),
      });
      // The record itself is beyond trust, but the records *after* it still have
      // to be checked: an auditor needs the whole damage report, not the first
      // row of it. Its position is salvaged so the sequence check keeps working;
      // its hash is only carried when the field is at least shaped like one, and
      // the record has already forced `ok: false` either way.
      previous = { seq: seq ?? (previous ? previous.seq + 1 : expectFirstSeq), hash: readHash(candidate) };
      index += 1;
      continue;
    }

    const event = parsed.data;

    if (previous === null && index === 0) {
      if (event.seq !== expectFirstSeq) {
        issues.push({
          kind: "bad_start",
          seq: event.seq,
          index,
          detail: `chain starts at seq ${event.seq}, expected ${expectFirstSeq}`,
        });
      }
      if (event.prevHash !== expectPrevHash) {
        issues.push({
          kind: "bad_start",
          seq: event.seq,
          index,
          detail: `first record points at ${event.prevHash}, expected ${expectPrevHash}`,
        });
      }
    } else if (previous !== null) {
      if (event.seq <= previous.seq) {
        issues.push({
          kind: "out_of_order",
          seq: event.seq,
          index,
          detail: `seq ${event.seq} follows seq ${previous.seq}`,
        });
      } else if (event.seq !== previous.seq + 1) {
        issues.push({
          kind: "sequence_gap",
          seq: previous.seq + 1,
          index,
          detail: `seq jumps from ${previous.seq} to ${event.seq} — ${event.seq - previous.seq - 1} record(s) missing`,
        });
      }
      if (previous.hash !== null && event.prevHash !== previous.hash) {
        issues.push({
          kind: "prev_hash_mismatch",
          seq: event.seq,
          index,
          detail: `prevHash ${event.prevHash} does not match the hash of seq ${previous.seq} (${previous.hash})`,
        });
      }
    }

    const expected = rehash(event);
    if (expected !== event.hash) {
      issues.push({
        kind: "hash_mismatch",
        seq: event.seq,
        index,
        detail: `stored hash ${event.hash} but the record hashes to ${expected} — the record was altered`,
      });
    }

    previous = { seq: event.seq, hash: event.hash };
    headHash = event.hash;
    index += 1;
  }

  if (index === 0) {
    // Every caller writes `if (result.ok)`. An emptied table answering "ok" is
    // the difference between a wiped audit trail and a verified one.
    issues.push({
      kind: "empty",
      seq: null,
      index: 0,
      detail: "no records were verified — an empty result proves nothing about the chain",
    });
  }

  const seqs = issues.map((issue) => issue.seq).filter((seq): seq is number => seq !== null);

  return {
    ok: issues.length === 0,
    checked: index,
    firstBadSeq: seqs.length > 0 ? Math.min(...seqs) : null,
    headHash: issues.length === 0 ? headHash : null,
    issues,
  };
}

function readSeq(candidate: unknown): number | null {
  if (typeof candidate !== "object" || candidate === null) return null;
  const seq = (candidate as { seq?: unknown }).seq;
  return typeof seq === "number" && Number.isFinite(seq) ? seq : null;
}

/** Best-effort predecessor hash of an unreadable record; `null` unless it is hex-shaped. */
function readHash(candidate: unknown): string | null {
  if (typeof candidate !== "object" || candidate === null) return null;
  const hash = (candidate as { hash?: unknown }).hash;
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash) ? hash : null;
}
