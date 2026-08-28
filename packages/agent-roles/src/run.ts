import type { z } from "zod";
import type { DataClass, LlmCallLog, LlmRole } from "@maestro/contracts";
import type { LlmPort } from "@maestro/ports";
import { RoleOutputError } from "./errors.js";
import { buildRepairPrompt } from "./prompt.js";
import { DEFAULT_PROMPT_TEXTS, type PromptTexts } from "./texts.js";
import type { Deficiency, Validation } from "./validate.js";

/**
 * Result of a thinking-role call.
 *
 * The three non-ok states are re-exposed unchanged from `LlmOutcome` on
 * purpose: a queued quota (M55), a data class no backend may see (M18/M97) and
 * a policy block are workflow decisions, not this package's business. Swallowing
 * them into an error here would turn "wait sixteen minutes" into "the run
 * failed".
 *
 * Every variant carries `logs`, including the non-ok ones: a first call that
 * reached a backend BURNED quota even if the repair round then hit a full pool.
 * Dropping that log would leave M55's window tracking and the evidence pack one
 * call short of what actually happened. `logs` is empty when no call landed.
 */
export type RoleResult<T> =
  | { status: "ok"; value: T; attempts: number; logs: LlmCallLog[] }
  | { status: "queued"; resumeAt: string; reason: "subscription_quota"; logs: LlmCallLog[] }
  | { status: "degraded"; messageKey: string; dataClass: DataClass; logs: LlmCallLog[] }
  | { status: "blocked"; messageKey: string; dataClass: DataClass; logs: LlmCallLog[] };

export interface RoleCall<T> {
  llm: LlmPort;
  role: LlmRole;
  variantId: string;
  dataClass: DataClass;
  schemaName: string;
  schema: z.ZodType<T>;
  prompt: string;
  /**
   * The only gate that counts. It re-validates the SHAPE against the same
   * generated schema and then the semantics on top of it, so a port that
   * skipped validation, a stale fixture or a hand-fed document is refused here
   * too — this package never trusts its caller's parsing (M43).
   */
  check: (value: unknown) => Validation<T>;
  texts?: PromptTexts;
}

/**
 * The attempt budget: one call plus at most two repair rounds (M43).
 *
 * Raised from 2 to 3 after CANLI BULGU-1: a real analyst filled every section
 * but skipped source rows, and a single repair round was not enough to recover.
 * The budget stays a constant on purpose — callers cannot loosen the fail-closed
 * gate, and there is never a partial document returned.
 */
export const MAX_ROLE_ATTEMPTS = 3;

/**
 * One call, at most `MAX_ROLE_ATTEMPTS - 1` repair rounds, then an error (M43).
 *
 * Every repair prompt carries the CONCRETE deficiency list rather than "try
 * again": a model told what is missing fixes it, a model told to retry
 * rewrites the same document. A still-deficient final answer is a hard failure —
 * there is no extra attempt and no partially valid document is ever returned.
 */
export async function runRole<T>(call: RoleCall<T>): Promise<RoleResult<T>> {
  const texts = call.texts ?? DEFAULT_PROMPT_TEXTS;
  // Logs of the calls that landed so far. An early call BURNED quota even if a
  // later round hits a full pool — they travel with every outcome so nothing
  // downstream sees a call that never happened (M55).
  const logs: LlmCallLog[] = [];
  let prompt = call.prompt;
  let deficiencies: readonly Deficiency[] = [];

  for (let attempt = 1; attempt <= MAX_ROLE_ATTEMPTS; attempt++) {
    const generated = await generate(call, prompt);
    if (generated.status !== "ok") return withLogs(generated, logs);
    logs.push(generated.log);

    const checked = call.check(generated.value);
    if (checked.ok) {
      return { status: "ok", value: checked.value, attempts: attempt, logs };
    }
    deficiencies = checked.deficiencies;
    // Always repaired against the ORIGINAL prompt plus the latest answer — the
    // model never sees a repair-of-a-repair chain, only base + newest state.
    prompt = buildRepairPrompt(call.prompt, generated.value, deficiencies, texts);
  }

  throw new RoleOutputError(
    call.role,
    MAX_ROLE_ATTEMPTS,
    deficiencies.map((d) => d.message),
  );
}

type NonOkResult = Exclude<RoleResult<never>, { status: "ok" }>;

/**
 * `Omit` collapses a union into one object type, which would let a `queued`
 * outcome be built without `resumeAt`. Distributing over the members keeps each
 * variant's own fields required.
 */
type WithoutLogs<T> = T extends unknown ? Omit<T, "logs"> : never;

type Generated = { status: "ok"; value: unknown; log: LlmCallLog } | WithoutLogs<NonOkResult>;

/** Attach the calls that already landed to a non-ok outcome (M55 accounting). */
function withLogs(outcome: WithoutLogs<NonOkResult>, logs: LlmCallLog[]): NonOkResult {
  return { ...outcome, logs } as NonOkResult;
}

async function generate<T>(call: RoleCall<T>, prompt: string): Promise<Generated> {
  const outcome = await call.llm.generateObject<T>(
    {
      role: call.role,
      variantId: call.variantId,
      dataClass: call.dataClass,
      schemaName: call.schemaName,
      input: prompt,
    },
    call.schema,
  );

  switch (outcome.status) {
    case "ok":
      // Handed to `check` unparsed on purpose: a shape miss must become a
      // repairable deficiency list, not an exception thrown mid-flight.
      return { status: "ok", value: outcome.value, log: outcome.log };
    case "queued":
      return { status: "queued", resumeAt: outcome.resumeAt, reason: outcome.reason };
    case "degraded":
      return { status: "degraded", messageKey: outcome.messageKey, dataClass: outcome.dataClass };
    case "blocked":
      return { status: "blocked", messageKey: outcome.messageKey, dataClass: outcome.dataClass };
  }
}
