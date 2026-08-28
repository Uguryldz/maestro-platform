import type { GateDecision, StepId } from "@maestro/contracts";
import { clip, oneLine, utcInstant } from "./summary-format.js";

/** A rejection reason is a sentence, not a pasted build log. */
export const MAX_REASON_CHARS = 500;

/** A gate whose latest decision is a rejection — work the agent still owes. */
export interface OpenRejection {
  readonly step: StepId;
  readonly at: string;
  readonly actorGroup: string;
  readonly reason: string;
}

/**
 * A decision the platform recorded but could not stand behind: the SoD check
 * (M32) did not pass. It closes nothing and it approves nothing; it is
 * surfaced so a human sees that someone signed without the right to.
 */
export interface SuspectDecision {
  readonly step: StepId;
  readonly at: string;
  readonly actorGroup: string;
  readonly actorUserId: string;
  readonly decision: GateDecision["decision"];
  readonly sodVerified: false;
}

export interface GateReview {
  readonly open: readonly OpenRejection[];
  readonly suspect: readonly SuspectDecision[];
}

/** `reject` sorts after `approve`, so a tie fails closed. */
function rank(decision: GateDecision): number {
  return decision.decision === "reject" ? 1 : 0;
}

/**
 * Read the gate history the way the gates themselves are defined.
 *
 * The reject/fix/re-approve loop (M54) means a later approval closes an
 * earlier rejection — but only the *same signer group's* approval does
 * (verifier Y-4). An M32 four-eyes gate carries two independent signatures
 * (PO ≠ TL, TL ≠ reviewer); keying the history by step alone let either
 * group's approval erase the other's rejection, and the agent then resumed
 * believing it owed nothing. The history is therefore keyed by
 * `step | actorGroup`.
 *
 * Two more rules, both fail-closed:
 *  - an approval whose `sodVerified` is false closes nothing. A signature the
 *    platform could not verify is evidence of a problem, not of consent, so it
 *    is reported separately instead;
 *  - when two decisions share a signed position (`signatureSeq` *and* `at`),
 *    the rejection wins, rather than whichever the array happened to hold last.
 *
 * Ordering is by `signatureSeq` (the signed, monotonic chain, M33), then by
 * timestamp, then by that tiebreak — never by array order.
 */
export function reviewGateDecisions(
  decisions: readonly GateDecision[],
  maskReason: (text: string) => string,
): GateReview {
  const ordered = [...decisions].sort(
    (a, b) => a.signatureSeq - b.signatureSeq || a.at.localeCompare(b.at) || rank(a) - rank(b),
  );

  const latest = new Map<string, GateDecision>();
  const suspect: SuspectDecision[] = [];
  for (const decision of ordered) {
    if (!decision.sodVerified) {
      suspect.push({
        step: decision.step,
        at: utcInstant(decision.at),
        actorGroup: decision.actorGroup,
        actorUserId: decision.actorUserId,
        decision: decision.decision,
        sodVerified: false,
      });
      // An unverified *rejection* still stops the flow: a stop needs no
      // authority. An unverified approval must not close anything.
      if (decision.decision === "approve") continue;
    }
    latest.set(`${decision.step}|${decision.actorGroup}`, decision);
  }

  const open = [...latest.values()]
    .filter((decision) => decision.decision === "reject")
    .sort((a, b) => a.signatureSeq - b.signatureSeq)
    .map((decision) => ({
      step: decision.step,
      at: utcInstant(decision.at),
      actorGroup: decision.actorGroup,
      // The contract guarantees a reject carries a reason; be explicit anyway,
      // an empty rejection reason must not read as "nothing to fix". Clipped
      // per field, so one pasted log cannot crowd out the rest of the
      // bootstrap text (verifier Y-3).
      reason: clip(maskReason(oneLine(decision.reason ?? "(no reason recorded)")), MAX_REASON_CHARS),
    }));

  return { open, suspect };
}

/** Gates whose most recent decision, by the rules above, is a rejection. */
export function openRejections(
  decisions: readonly GateDecision[],
  maskReason: (text: string) => string,
): readonly OpenRejection[] {
  return reviewGateDecisions(decisions, maskReason).open;
}
