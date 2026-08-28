import type { DataClass } from "@maestro/contracts";
import {
  compiledProfileFor,
  createSessionWith,
  maskValue,
  type LoadedPiiPolicy,
  type MaskCounts,
} from "@maestro/pii";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE IDE BOUNDARY  (verifier B9 · M20 · M82 · M101)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `maestro-mcp` is the one server of four that does not face a sandbox.
 *
 * The other three serve an agent session running inside the runner: whatever
 * they hand back is read by a model whose own egress already passes through
 * `@maestro/pii` at the LLM gateway. Masking a Jira ticket before that agent
 * reads it would leave it unable to do the analysis it was started for, and
 * would buy nothing — the boundary is downstream.
 *
 * `maestro-mcp` faces a PERSON'S IDE. The result lands on a personal machine
 * and goes on to whichever model that IDE is wired to, which is outside the
 * platform's egress path entirely. `get_journal` returned raw `JournalEntry[]`
 * and `search_knowledge` returned raw snippets — an analysis quotes a ticket
 * verbatim, and a ticket in this bank contains a TCKN. So this channel gets its
 * own boundary, applied to the RESULT of every tool on the way out.
 *
 * Two controls, because they answer different questions:
 *  · **mask** — identifiers become session tokens. Applies to everything.
 *  · **filter** — a `gizli` knowledge document is DROPPED, not tokenised.
 *    Masking removes identifiers; it does not make a confidential document
 *    safe to place on a personal laptop, and the class is the institution's
 *    statement about the document as a whole.
 *
 * Opt-in by design. A package that masked by default would mask the offline
 * demo's fixtures and would hide the wiring bug where the composition root
 * forgot to pass a policy — a silent default is how a control goes missing.
 */

/** Audit hook (M33 `PII_MASKED`). Receives counts — never values. */
export type IdeMaskedHook = (counts: MaskCounts, tool: string) => void;

export interface IdePiiOptions {
  /** A policy that went through `loadPiiPolicy` (branded, so a literal cannot be used). */
  readonly policy: LoadedPiiPolicy;
  readonly onMasked?: IdeMaskedHook;
  /**
   * The class this channel is treated as. `dahili` by default: the caller is a
   * corporate account on a corporate machine, so the internal-account patterns
   * apply. A stricter deployment passes `gizli`.
   */
  readonly dataClass?: DataClass;
}

/** Something the platform labelled. Anything unlabelled is treated as `dahili`. */
export interface MaybeClassified {
  readonly dataClass?: DataClass;
}

/**
 * The classes this channel may carry. `gizli` is absent on purpose — see the
 * header. This is a value, not a check, so the omission is reviewable.
 */
const ALLOWED_ON_THIS_CHANNEL: readonly DataClass[] = ["acik", "dahili"];

export function allowedOnIdeChannel(item: MaybeClassified): boolean {
  return ALLOWED_ON_THIS_CHANNEL.includes(item.dataClass ?? "dahili");
}

/**
 * The masking gate for one tool's result.
 *
 * A fresh session per call: the token vocabulary and its reverse map are
 * created and dropped inside this frame, so two calls never share a token and
 * the map reaches nobody. There is deliberately no un-masking half — this
 * boundary is one-way. Nothing downstream of an IDE gets to ask for the real
 * value back, which is the entire point.
 */
export function maskForIde<T>(value: T, tool: string, options: IdePiiOptions): T {
  const { profile } = compiledProfileFor(options.policy, options.dataClass ?? "dahili");
  const session = createSessionWith(profile);
  const masked = maskValue(value, session);
  options.onMasked?.(masked.counts, tool);
  return masked.value;
}
