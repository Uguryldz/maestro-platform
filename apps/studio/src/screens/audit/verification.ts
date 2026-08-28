/**
 * How the Studio presents an audit-chain verification result.
 *
 * SECURITY RULE: the chain's own record is not evidence about itself. A response
 * that merely asserts `ok: true` must NOT be rendered as a green "integrity
 * verified" badge, because the badge would then restate the claim rather than
 * report a check of it. What we show is the verdict TOGETHER WITH what it rests
 * on — how many records were actually re-hashed, and out of how many.
 *
 * The wire shape is the BFF's `GET /studio/audit/verification`
 * (apps/bff/src/read-models.ts): `{ ok, checked, brokenAtSeq }`. That endpoint
 * recomputes the chain rather than reading a stored flag, which is what makes
 * `checked` meaningful: it is the count of records this run re-hashed.
 *
 * Note what is deliberately NOT claimed here. Recomputing a chain proves it is
 * internally consistent; it cannot prove the chain was not rewritten wholesale,
 * because a rewriter would recompute the hashes too. Only comparison against an
 * anchor held in a separate system shows that, and this endpoint does not report
 * one — so a pass is labelled "internally consistent", never "tamper-proof", and
 * `audit.basis.no_anchor` is always stated alongside it.
 */

/** What `GET /studio/audit/verification` returns. */
export interface ChainVerification {
  /** The server's verdict. Not shown as green on its own — see `assess`. */
  readonly ok: boolean;
  /** How many records this run re-hashed. Zero means nothing was checked. */
  readonly checked: number;
  /** First sequence number that did not reconcile; null when none did. */
  readonly brokenAtSeq: number | null;
}

export type Assessment =
  /** Records were re-hashed and the chain reconciled. */
  | "consistent"
  /** The chain does not reconcile — always shown, never softened. */
  | "broken"
  /** The server says ok, but the check covered no records. */
  | "unsubstantiated"
  /** No verification result is available yet. */
  | "not_run";

export interface AssessedChain {
  readonly assessment: Assessment;
  /** Catalog keys naming exactly what the verdict rests on. */
  readonly basis: readonly string[];
  readonly tone: "green" | "red" | "amber" | "gray";
}

/**
 * Turn a raw server report into a verdict we are willing to display, plus the
 * basis for it.
 *
 * A broken verdict is always surfaced as broken, whatever else the payload
 * says — a failing integrity check is never downgraded. An `ok` that re-hashed
 * nothing is NOT shown as a pass: it is `unsubstantiated`, because a verdict
 * reached without doing any work is the claim, not a check of it.
 */
export function assess(report: ChainVerification | undefined): AssessedChain {
  if (report === undefined) {
    return { assessment: "not_run", basis: ["audit.basis.never_run"], tone: "gray" };
  }

  if (!report.ok || report.brokenAtSeq !== null) {
    return {
      assessment: "broken",
      basis: ["audit.basis.mismatch", "audit.basis.rehashed"],
      tone: "red",
    };
  }

  if (report.checked <= 0) {
    return {
      assessment: "unsubstantiated",
      basis: ["audit.basis.nothing_rehashed", "audit.basis.no_anchor"],
      tone: "amber",
    };
  }

  return {
    assessment: "consistent",
    // Stated together on purpose: what the recomputation does show, and the
    // stronger property it cannot show.
    basis: ["audit.basis.rehashed", "audit.basis.no_anchor"],
    tone: "green",
  };
}
