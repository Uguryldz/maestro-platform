import { createHmac, timingSafeEqual } from "node:crypto";
import { IsoDateTime, Sha256Hex, type AuditEvent } from "@maestro/contracts";
import { z } from "zod";
import { canonicalize } from "./canonical.js";
import { AuditAnchorError } from "./errors.js";
import { GENESIS, sha256Hex } from "./hash.js";
import { verifyChain, type ChainVerification } from "./verify.js";

/**
 * Daily anchor (M33). A hash chain only proves that nobody edited a record
 * *without* rewriting everything after it. Someone who can rewrite the whole
 * table can produce a perfectly consistent forgery. The anchor closes that:
 * once a day the chain head is summarised, signed, and written somewhere the
 * database owner does not control (WORM bucket, SIEM, printed report — M5/M57).
 * A rewritten chain then contradicts yesterday's signed digest.
 *
 * Where the anchor is stored is the caller's decision (StoragePort, file drop);
 * this package only builds and checks it.
 */
const UtcDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const AuditAnchorBody = z.object({
  version: z.literal(1),
  /** UTC day covered, `YYYY-MM-DD`. */
  day: UtcDay,
  createdAt: IsoDateTime,
  algorithm: z.literal("sha256"),
  firstSeq: z.number().int().positive(),
  lastSeq: z.number().int().positive(),
  eventCount: z.number().int().positive(),
  /** `prevHash` of the day's first record — links this anchor to the previous one. */
  prevHash: Sha256Hex.or(z.literal(GENESIS)),
  /** Hash of the day's last record: the chain head at the moment of anchoring. */
  headHash: Sha256Hex,
  /** SHA-256 over the canonical list of the day's record hashes. */
  chainDigest: Sha256Hex,
});
export type AuditAnchorBody = z.infer<typeof AuditAnchorBody>;

export const AuditAnchor = AuditAnchorBody.extend({
  signature: z.object({
    alg: z.string().min(1),
    keyId: z.string().min(1),
    value: z.string().min(1),
  }),
});
export type AuditAnchor = z.infer<typeof AuditAnchor>;

/**
 * Signing seam. HMAC is the offline default; a KMS/HSM signer can be injected
 * later without touching the anchor logic.
 */
export interface AnchorSigner {
  readonly alg: string;
  readonly keyId: string;
  sign(payload: string): Promise<string>;
  verify(payload: string, signature: string): Promise<boolean>;
}

export class HmacAnchorSigner implements AnchorSigner {
  readonly alg = "hmac-sha256";

  constructor(
    readonly keyId: string,
    private readonly key: string | Uint8Array,
  ) {
    if (keyId.length === 0) throw new AuditAnchorError("bad_signer", "keyId must not be empty");
    if (key.length === 0) throw new AuditAnchorError("bad_signer", "signing key must not be empty");
  }

  sign(payload: string): Promise<string> {
    return Promise.resolve(createHmac("sha256", this.key).update(payload, "utf8").digest("hex"));
  }

  async verify(payload: string, signature: string): Promise<boolean> {
    const expected = Buffer.from(await this.sign(payload), "utf8");
    const provided = Buffer.from(signature, "utf8");
    return expected.length === provided.length && timingSafeEqual(expected, provided);
  }
}

/** UTC calendar day of an ISO instant. */
export function utcDayOf(at: string | Date): string {
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) throw new AuditAnchorError("bad_day", `${String(at)} is not an instant`);
  return date.toISOString().slice(0, 10);
}

/** Records that fall on the given UTC day. */
export function eventsOfDay(events: readonly AuditEvent[], day: string): AuditEvent[] {
  if (!UtcDay.safeParse(day).success) throw new AuditAnchorError("bad_day", `${day} is not YYYY-MM-DD`);
  return events.filter((event) => utcDayOf(event.at) === day);
}

/** The value that gets signed: the canonical form of the unsigned anchor. */
export function anchorPayload(body: AuditAnchorBody): string {
  return canonicalize(AuditAnchorBody.parse(body));
}

export interface BuildAnchorOptions {
  /** The day's records, in chain order. */
  readonly events: readonly AuditEvent[];
  readonly signer: AnchorSigner;
  /**
   * `headHash` of the previous day's anchor, or `GENESIS` for the very first
   * anchor. **Required**: an anchor that takes the expected link from the day's
   * own first record signs whatever it is given, so deleting that record before
   * anchoring makes the truncation permanently legitimate.
   */
  readonly expectPrevHash: string;
  /**
   * `lastSeq` of the previous day's anchor + 1. Required unless `expectPrevHash`
   * is `GENESIS`, where the only possible answer is 1.
   */
  readonly expectFirstSeq?: number;
  /** Defaults to the day of the first record; records outside it are an error. */
  readonly day?: string;
  /** Anchor creation instant; injected so anchors are reproducible in tests. */
  readonly now: Date;
}

/**
 * Build and sign the anchor for one day. The slice is verified first — signing
 * a chain that is already broken, or a day whose first records were removed,
 * would only certify the damage.
 */
export async function buildAnchor(options: BuildAnchorOptions): Promise<AuditAnchor> {
  const { events, signer, now, expectPrevHash } = options;
  const first = events[0];
  const last = events.at(-1);
  if (!first || !last) {
    // A day with no records needs no anchor: the head has not moved, so the
    // previous anchor still covers the chain.
    throw new AuditAnchorError("empty_day", "an anchor over zero records proves nothing");
  }

  const expectFirstSeq = options.expectFirstSeq ?? (expectPrevHash === GENESIS ? 1 : undefined);
  if (expectFirstSeq === undefined) {
    throw new AuditAnchorError(
      "missing_expectation",
      "expectFirstSeq is required when the anchor continues a previous one (previous anchor's lastSeq + 1)",
    );
  }

  const day = options.day ?? utcDayOf(first.at);
  const outside = events.find((event) => utcDayOf(event.at) !== day);
  if (outside) {
    throw new AuditAnchorError("mixed_days", `seq ${outside.seq} is not on ${day}`);
  }

  const chain = verifyChain(events, { expectFirstSeq, expectPrevHash });
  if (!chain.ok) {
    throw new AuditAnchorError(
      "chain_broken",
      `refusing to anchor: first bad record is seq ${String(chain.firstBadSeq)} (${chain.issues[0]?.detail ?? ""})`,
    );
  }

  const body: AuditAnchorBody = AuditAnchorBody.parse({
    version: 1,
    day,
    createdAt: now.toISOString(),
    algorithm: "sha256",
    // Taken from the caller's expectation, which `verifyChain` just proved the
    // records satisfy — not from the records themselves.
    firstSeq: expectFirstSeq,
    lastSeq: last.seq,
    eventCount: events.length,
    prevHash: expectPrevHash,
    headHash: last.hash,
    chainDigest: chainDigestOf(events),
  });

  return AuditAnchor.parse({
    ...body,
    signature: { alg: signer.alg, keyId: signer.keyId, value: await signer.sign(anchorPayload(body)) },
  });
}

/** Digest over every record hash of the day, not only the head. */
export function chainDigestOf(events: readonly AuditEvent[]): string {
  return sha256Hex(canonicalize(events.map((event) => event.hash)));
}

export interface AnchorVerification {
  readonly ok: boolean;
  readonly reasons: readonly string[];
  /** Result of re-verifying the records the anchor covers, when they were supplied. */
  readonly chain: ChainVerification | null;
}

/**
 * Check an anchor: signature first, then — if the day's records are supplied —
 * that they are still the records the anchor was made over.
 */
export async function verifyAnchor(
  anchor: unknown,
  signer: AnchorSigner,
  events?: readonly AuditEvent[],
): Promise<AnchorVerification> {
  const parsed = AuditAnchor.safeParse(anchor);
  if (!parsed.success) {
    return { ok: false, reasons: [`anchor does not match its schema: ${parsed.error.issues[0]?.message ?? ""}`], chain: null };
  }

  const { signature, ...body } = parsed.data;
  const reasons: string[] = [];

  if (signature.keyId !== signer.keyId || signature.alg !== signer.alg) {
    reasons.push(`anchor was signed with ${signature.alg}/${signature.keyId}, verifier holds ${signer.alg}/${signer.keyId}`);
  } else if (!(await signer.verify(anchorPayload(body), signature.value))) {
    reasons.push("signature does not match the anchor body — the anchor was altered");
  }

  let chain: ChainVerification | null = null;
  if (events) {
    chain = verifyChain(events, { expectFirstSeq: body.firstSeq, expectPrevHash: body.prevHash });
    if (!chain.ok) reasons.push(`records do not verify: first bad seq ${String(chain.firstBadSeq)}`);
    if (events.length !== body.eventCount) reasons.push(`anchor covers ${body.eventCount} records, ${events.length} supplied`);
    if (events.at(-1)?.hash !== body.headHash) reasons.push("head hash differs — the day's last record was replaced");
    if (chainDigestOf(events) !== body.chainDigest) reasons.push("chain digest differs — the day's records were altered");
  }

  return { ok: reasons.length === 0, reasons, chain };
}

/** Audit records and evidence are kept for ten years (M56). */
export const AUDIT_RETENTION_YEARS = 10;

/** Instant at which a record written at `at` may be disposed of (M56 lifecycle). */
export function retentionExpiryOf(at: string | Date): string {
  const date = at instanceof Date ? new Date(at.getTime()) : new Date(at);
  if (Number.isNaN(date.getTime())) throw new AuditAnchorError("bad_day", `${String(at)} is not an instant`);
  date.setUTCFullYear(date.getUTCFullYear() + AUDIT_RETENTION_YEARS);
  return date.toISOString();
}
