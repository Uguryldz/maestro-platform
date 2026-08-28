import {
  ApiDriverId,
  DataClass,
  LlmDriverId,
  LlmRole,
  NonEmpty,
  QuotaWindowKind,
  SubscriptionDriverId,
  isSubscriptionDriver,
} from "@maestro/contracts";
import { z } from "zod";
import { LlmConfigError } from "./errors.js";

export const LLM_PORT = "llm";
export const LLM_GATEWAY_DRIVER = "gateway";

/** Any variant matches this binding (M38 variant set is open-ended). */
export const ANY_VARIANT = "*";

/** M18: what to do for the `gizli` class when no on-prem backend is available. */
export const OnPremMissingAction = z.enum(["degrade_ai_assist", "block", "masked_cloud"]);
export type OnPremMissingAction = z.infer<typeof OnPremMissingAction>;

const base = {
  enabled: z.boolean().default(true),
  /** On-prem backends are the only ones the `gizli` class may reach (M18). */
  onPrem: z.boolean().default(false),
  timeoutMs: z.number().int().positive().max(600_000).default(60_000),
};

/** API drivers (M16). Secrets are REFERENCES resolved through SecretPort (M80). */
export const DriverConfig = z.discriminatedUnion("driver", [
  z.object({
    driver: z.literal("anthropic-direct"),
    baseUrl: z.url().default("https://api.anthropic.com"),
    apiKeyRef: NonEmpty,
    apiVersion: NonEmpty.default("2023-06-01"),
    ...base,
  }),
  z.object({
    driver: z.literal("openai-compat"),
    baseUrl: z.url(),
    apiKeyRef: NonEmpty,
    ...base,
  }),
  z.object({
    driver: z.literal("aws-bedrock"),
    region: NonEmpty,
    /** Defaults to the public regional endpoint; override for a VPC endpoint. */
    baseUrl: z.url().optional(),
    anthropicVersion: NonEmpty.default("bedrock-2023-05-31"),
    ...base,
  }),
  z.object({
    driver: z.literal("google-vertex"),
    projectId: NonEmpty,
    location: NonEmpty,
    anthropicVersion: NonEmpty.default("vertex-2023-10-16"),
    ...base,
  }),
]);
export type DriverConfig = z.infer<typeof DriverConfig>;

/**
 * One subscription seat (M55). Cost is quota, not dollars: `costPctPerCall` is
 * per window, because a 5h window fills far faster than the weekly cap. The
 * figures are an estimate until the vendor reports real usage (see RAPOR.md).
 * `transport` is the API driver that physically carries the call.
 */
export const SubscriptionAccountConfig = z.object({
  accountId: NonEmpty,
  driver: SubscriptionDriverId,
  transport: ApiDriverId,
  credentialRef: NonEmpty,
  windows: z.array(z.object({ kind: QuotaWindowKind, costPctPerCall: z.number().positive().max(100).default(1) })).min(1),
  enabled: z.boolean().default(true),
});
export type SubscriptionAccountConfig = z.infer<typeof SubscriptionAccountConfig>;

export const SubscriptionPoolConfig = z.object({
  accounts: z.array(SubscriptionAccountConfig).default([]),
  /** A window at or above this percentage counts as exhausted. */
  exhaustedAtPct: z.number().min(1).max(100).default(95),
  /** Minimum gap between two calls on the same seat. */
  cooldownMs: z.number().int().nonnegative().default(0),
});
export type SubscriptionPoolConfig = z.infer<typeof SubscriptionPoolConfig>;

export const RateLimitConfig = z.object({
  capacity: z.number().int().positive().default(10),
  refillPerSecond: z.number().positive().default(2),
});
export type RateLimitConfig = z.infer<typeof RateLimitConfig>;

export const RetryConfig = z.object({
  maxAttempts: z.number().int().min(1).max(5).default(3),
  baseDelayMs: z.number().int().positive().default(500),
  maxDelayMs: z.number().int().positive().default(8_000),
  /** 0 = fully deterministic backoff; randomness is injected, never global. */
  jitterRatio: z.number().min(0).max(1).default(0),
});
export type RetryConfig = z.infer<typeof RetryConfig>;

/** Role (+ variant) → model, M17/M38. `variantId: "*"` is the fallback row. */
export const ModelBinding = z.object({
  role: LlmRole,
  variantId: NonEmpty.default(ANY_VARIANT),
  driver: LlmDriverId,
  model: NonEmpty,
});
export type ModelBinding = z.infer<typeof ModelBinding>;

/** Data class → permitted backends (M18 `routing.yaml`). */
export const DataClassRoute = z.object({
  dataClass: DataClass,
  allowedDrivers: z.array(LlmDriverId).min(1),
});
export type DataClassRoute = z.infer<typeof DataClassRoute>;

export const LlmGatewayConfig = z
  .object({
    drivers: z.array(DriverConfig).default([]),
    bindings: z.array(ModelBinding).min(1),
    routes: z.array(DataClassRoute).min(1),
    onPremMissing: OnPremMissingAction.default("degrade_ai_assist"),
    subscriptionPool: SubscriptionPoolConfig.prefault({}),
    rateLimit: RateLimitConfig.prefault({}),
    retry: RetryConfig.prefault({}),
    maxTokens: z.number().int().positive().default(4_096),
    temperature: z.number().min(0).max(2).default(0),
    /**
     * Role recorded for `agentSession` calls (doing roles — M17). The data class
     * and the variant are NOT config: `AgentSessionOptions` carries them, so the
     * gateway never routes an agent turn with a default (M18).
     */
    agentRole: LlmRole.default("engineer"),
  })
  .superRefine((cfg, ctx) => {
    const configured = new Set<string>(cfg.drivers.map((d) => d.driver));
    const pooled = new Set<string>(cfg.subscriptionPool.accounts.map((a) => a.driver));
    for (const [i, b] of cfg.bindings.entries()) {
      const known = isSubscriptionDriver(b.driver) ? pooled.has(b.driver) : configured.has(b.driver);
      if (!known) {
        ctx.addIssue({
          code: "custom",
          path: ["bindings", i, "driver"],
          message: `binding uses driver "${b.driver}" which is neither configured nor in the subscription pool`,
        });
      }
    }
    for (const [i, a] of cfg.subscriptionPool.accounts.entries()) {
      if (!configured.has(a.transport)) {
        ctx.addIssue({
          code: "custom",
          path: ["subscriptionPool", "accounts", i, "transport"],
          message: `transport "${a.transport}" is not a configured driver`,
        });
      }
    }
    for (const dc of DataClass.options) {
      if (!cfg.routes.some((r) => r.dataClass === dc)) {
        ctx.addIssue({ code: "custom", path: ["routes"], message: `no route for data class "${dc}"` });
      }
    }
    // M18: a subscription seat is a consumer contract with no enterprise data
    // agreement. Refusing it at install time means the compliance team cannot
    // put one on the confidential route by accident in the first place.
    for (const [i, route] of cfg.routes.entries()) {
      if (route.dataClass !== "gizli") continue;
      for (const [j, driver] of route.allowedDrivers.entries()) {
        if (!isSubscriptionDriver(driver)) continue;
        ctx.addIssue({
          code: "custom",
          path: ["routes", i, "allowedDrivers", j],
          message: `subscription driver "${driver}" may not serve the "gizli" data class`,
        });
      }
    }
  });
export type LlmGatewayConfig = z.infer<typeof LlmGatewayConfig>;

/** Fail-closed config gate: a half-valid gateway never starts (M6). */
export function parseGatewayConfig(input: unknown): LlmGatewayConfig {
  const parsed = LlmGatewayConfig.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new LlmConfigError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
}
