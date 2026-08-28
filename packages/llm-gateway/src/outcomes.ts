import type { LlmCallLog } from "@maestro/contracts";
import type { AgentSessionResult, LlmOutcome } from "@maestro/ports";
import type { PolicyDecision } from "./policy.js";

/**
 * The non-ok branches are taken FROM the port type, never redeclared, so the
 * gateway cannot drift from `LlmOutcome` without a compile error.
 */
export type QueuedOutcome = Extract<LlmOutcome<unknown>, { status: "queued" }>;
export type DegradedOutcome = Extract<LlmOutcome<unknown>, { status: "degraded" }>;
export type BlockedOutcome = Extract<LlmOutcome<unknown>, { status: "blocked" }>;

/** M55: the pool is full — the caller waits (Temporal timer), nothing failed. */
export const QUEUE_REASON_QUOTA = "subscription_quota" as const;

/**
 * M20/M82: on a masked route the returned value stays MASKED — that is the copy
 * an artifact store or a journal may keep — and `unmask` is the only way back
 * to the real values, for a surface that is showing them to a human right now.
 * It is absent when nothing was masked.
 *
 * This widens the port's `ok` branch (structurally, so `LlmGateway` still
 * satisfies `LlmPort`); a caller typed as `LlmPort` simply never sees it.
 */
export interface Unmaskable {
  unmask?: <R>(value: R) => R;
}

export type GatewayOutcome<T> =
  | ({ status: "ok"; value: T; log: LlmCallLog } & Unmaskable)
  | QueuedOutcome
  | DegradedOutcome
  | BlockedOutcome;

export type SessionOutcome = GatewayOutcome<AgentSessionResult>;

/**
 * M18: `degrade_ai_assist` and `block` are different ANSWERS, not two spellings
 * of one error — degraded means the flow continues human-led (M97), blocked
 * means it stops. The policy decision maps one-to-one onto the port state.
 */
export function haltedFrom(decision: Exclude<PolicyDecision, { kind: "allow" }>): DegradedOutcome | BlockedOutcome {
  const { dataClass, messageKey } = decision;
  return decision.kind === "degrade"
    ? { status: "degraded", dataClass, messageKey }
    : { status: "blocked", dataClass, messageKey };
}
