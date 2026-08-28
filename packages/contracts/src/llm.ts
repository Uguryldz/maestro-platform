import { z } from "zod";
import { DataClass, IsoDateTime, NonEmpty, RunId } from "./common.js";

/** API drivers (M16). */
export const ApiDriverId = z.enum([
  "anthropic-direct",
  "aws-bedrock",
  "google-vertex",
  "openai-compat",
]);
export type ApiDriverId = z.infer<typeof ApiDriverId>;

/** Subscription drivers — account pool with quota windows (M55). */
export const SubscriptionDriverId = z.enum(["claude-sub", "gemini-sub", "codex-sub"]);
export type SubscriptionDriverId = z.infer<typeof SubscriptionDriverId>;

export const LlmDriverId = z.enum([...ApiDriverId.options, ...SubscriptionDriverId.options]);
export type LlmDriverId = z.infer<typeof LlmDriverId>;

export function isSubscriptionDriver(d: LlmDriverId): boolean {
  return (SubscriptionDriverId.options as readonly string[]).includes(d);
}

export const QuotaWindowKind = z.enum(["5h", "weekly"]);
export type QuotaWindowKind = z.infer<typeof QuotaWindowKind>;

export const QuotaWindow = z.object({
  kind: QuotaWindowKind,
  usedPct: z.number().min(0).max(100),
  resetsAt: IsoDateTime,
});
export type QuotaWindow = z.infer<typeof QuotaWindow>;

export const SubscriptionAccountState = z.enum(["ready", "cooling", "exhausted", "disabled"]);
export type SubscriptionAccountState = z.infer<typeof SubscriptionAccountState>;

/**
 * One account in the subscription pool (M55). When the whole pool is
 * exhausted the workflow QUEUES (Temporal wait) instead of failing.
 */
export const SubscriptionAccount = z.object({
  accountId: NonEmpty,
  driver: SubscriptionDriverId,
  windows: z.array(QuotaWindow).min(1),
  state: SubscriptionAccountState,
  lastUsedAt: IsoDateTime.nullable().default(null),
});
export type SubscriptionAccount = z.infer<typeof SubscriptionAccount>;

/** Thinking + doing roles (M17/M43). */
export const LlmRole = z.enum([
  "intake",
  "analyst",
  "engineer",
  "dev_reviewer",
  "test_designer",
  "test_reviewer",
  "test_engineer",
]);
export type LlmRole = z.infer<typeof LlmRole>;

/** One gateway call log row. usd is null for subscription drivers (cost = quota, M55). */
export const LlmCallLog = z.object({
  at: IsoDateTime,
  runId: RunId.nullable().default(null),
  role: LlmRole,
  variantId: NonEmpty,
  driver: LlmDriverId,
  model: NonEmpty,
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  cachePct: z.number().min(0).max(100).nullable().default(null),
  usd: z.number().nonnegative().nullable().default(null),
  dataClass: DataClass,
});
export type LlmCallLog = z.infer<typeof LlmCallLog>;

/** Request shape for thinking roles (structured output via schema name). */
export const GenerateObjectRequest = z.object({
  role: LlmRole,
  variantId: NonEmpty,
  dataClass: DataClass,
  schemaName: NonEmpty,
  input: z.unknown(),
});
export type GenerateObjectRequest = z.infer<typeof GenerateObjectRequest>;
