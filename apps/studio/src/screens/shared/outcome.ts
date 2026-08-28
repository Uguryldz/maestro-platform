import type { BadgeTone } from "../../ui/index.ts";

/**
 * What happened to an LLM request when policy or quota intervened (M55/M18).
 *
 * This is the vocabulary the cost, llm and routing screens share so that
 * "the quota ran out" looks the same everywhere:
 *
 *  - `ok`       — served normally.
 *  - `queued`   — the whole subscription pool was exhausted, so the workflow
 *                 WAITS (Temporal timer) and resumes when a window opens. Work
 *                 is not lost and not failed; it is parked.
 *  - `degraded` — served, but not as asked: an on-prem model that cannot drive
 *                 the Agent SDK forces the run down to ai_assist (AI proposes,
 *                 a human applies).
 *  - `blocked`  — policy refused the call outright (e.g. `gizli` data with no
 *                 permitted backend). Nothing was sent.
 *
 * `queued` and `degraded` are deliberately NOT green: the work did not proceed
 * as requested, and a screen that painted them green would hide the reason a
 * run is sitting still.
 */
export type LlmOutcome = "ok" | "queued" | "degraded" | "blocked";

export const LLM_OUTCOMES: readonly LlmOutcome[] = ["ok", "queued", "degraded", "blocked"];

const KNOWN: readonly string[] = LLM_OUTCOMES;

/** Normalise a wire value; anything unrecognised is treated as `blocked`. */
export function toOutcome(raw: unknown): LlmOutcome {
  if (typeof raw === "string" && KNOWN.includes(raw)) return raw as LlmOutcome;
  return "blocked";
}

export function outcomeTone(raw: unknown): BadgeTone {
  switch (toOutcome(raw)) {
    case "ok":
      return "green";
    case "queued":
      return "amber";
    case "degraded":
      return "orange";
    default:
      return "red";
  }
}

/** Catalog key for the outcome label. */
export function outcomeKey(raw: unknown): string {
  return `llm.outcome.${toOutcome(raw)}`;
}

/** Catalog key explaining what the outcome means for the run. */
export function outcomeExplanationKey(raw: unknown): string {
  return `llm.outcome_hint.${toOutcome(raw)}`;
}

/**
 * What the subscription pool's capacity means for work arriving right now.
 *
 * `GET /studio/quota` reports `pool.hasCapacity`; when it is false every account
 * is spent and the next run QUEUES rather than failing. An undefined value means
 * we have not been told yet, which is not the same as "fine" — it maps to
 * `blocked` so an unknown pool never renders as a green light.
 */
export function poolOutcome(hasCapacity: boolean | undefined): LlmOutcome {
  if (hasCapacity === undefined) return "blocked";
  return hasCapacity ? "ok" : "queued";
}
