import type { z } from "zod";
import type { DataClass, GenerateObjectRequest, LlmCallLog } from "@maestro/contracts";

export interface AgentSessionOptions {
  workspacePath: string;
  task: string;
  resumeToken?: string;
  /** Tool access is MCP-first (K66); allowed server names, not raw tools. */
  mcpServers: string[];
  /**
   * Data class of the work this turn touches (M18). It comes from the CALLER and
   * the gateway never falls back to a configured default: the class decides
   * whether the turn may leave the bank at all, and a doing role on the `gizli`
   * class is the one that degrades to ai-assist (M97). A wrong class here is a
   * data-egress incident, not a routing preference.
   */
  dataClass: DataClass;
  /** Variant this session belongs to (M38); `"*"` when the caller has none. */
  variantId: string;
}

export interface AgentSessionResult {
  resumeToken: string;
  finalText: string;
  /** Same row as the enclosing `LlmOutcome.log` — kept so a resumed session can be logged on its own. */
  log: LlmCallLog;
}

/**
 * Every end state an LLM call can reach that is NOT a failure (M18/M55/M97).
 *
 * These four are RETURN VALUES, never exceptions, and callers must branch on
 * `status` (an exhaustive switch — adding a state should break compilation):
 * - `ok` — the call happened; `value` is the schema-valid result.
 * - `queued` — M55: the subscription pool is exhausted, nothing was sent and
 *   nothing failed. The caller waits until `resumeAt` (a Temporal timer) and
 *   retries. `reason` says which quota is being waited on.
 * - `degraded` — M18 `degrade_ai_assist`: no permitted backend may see this data
 *   class, so the FLOW CONTINUES without the model, human-led in ai-assist mode
 *   (M97). Work is still done; it is just not done by an LLM.
 * - `blocked` — M18 `block`: policy forbids this call outright, so the FLOW
 *   STOPS and waits for a compliance decision. There is no ai-assist fallback.
 *
 * `degraded` and `blocked` differ only in what the caller must do next, which is
 * exactly why they are separate states instead of one error with a message key.
 *
 * Real failures stay exceptions: network/transport errors, non-2xx provider
 * responses, misconfiguration/wiring bugs, and structured output that misses its
 * schema. None of those may be reshaped into an outcome — an outcome means the
 * gateway made a decision, an exception means something broke.
 */
export type LlmOutcome<T> =
  | { status: "ok"; value: T; log: LlmCallLog }
  /** `resumeAt` is an ISO-8601 datetime: the earliest moment a retry can succeed. */
  | { status: "queued"; resumeAt: string; reason: "subscription_quota" }
  /** `messageKey` is an i18n key (M104); the text lives in packages/config/locales. */
  | { status: "degraded"; messageKey: string; dataClass: DataClass }
  | { status: "blocked"; messageKey: string; dataClass: DataClass };

/**
 * LLM gateway port (M16/M17/M55). Driver selection (api vs subscription
 * pool) is policy inside the gateway, invisible to callers. Quota exhaustion and
 * data-class policy are reported through `LlmOutcome`, so no caller has to match
 * on an error message to tell "wait", "continue without AI" and "stop" apart.
 */
export interface LlmPort {
  /** Thinking roles: single structured-output call validated against schema. */
  generateObject<T>(req: GenerateObjectRequest, schema: z.ZodType<T>): Promise<LlmOutcome<T>>;
  /** Doing roles: delegated agent session (Claude Agent SDK — M17). */
  agentSession(opts: AgentSessionOptions): Promise<LlmOutcome<AgentSessionResult>>;
}
