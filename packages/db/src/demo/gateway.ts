import type { Prisma } from "@prisma/client";
import { ago, demoRunId } from "./clock.js";

/** LLM gateway log, prompt variants and the subscription pool (M16/M17/M55). */

/**
 * Every call is timed inside its run's own `[startedAt, updatedAt]` window —
 * a gateway call attributed to a run that had already closed is a cost report
 * nobody can reconcile.
 */
export const LLM_CALLS: Prisma.LlmCallCreateManyInput[] = [
  { at: ago(0.2), runId: demoRunId("UGURPAY-123"), role: "test_engineer", variantId: "engineer-web", driver: "anthropic-direct", model: "claude-opus-5", tokensIn: 48_200, tokensOut: 6_100, cachePct: 71, usd: "0.42", dataClass: "dahili" },
  { at: ago(1.2), runId: demoRunId("UGURPAY-502"), role: "engineer", variantId: "engineer-ios", driver: "claude-sub", model: "claude-opus-5", tokensIn: 96_400, tokensOut: 12_800, cachePct: 78, usd: null, dataClass: "dahili" },
  // `gizli` work goes to the on-prem model, which is what dataclass.policy
  // prescribes for the class (M18/M63) — and UGURDESK-52 is a `gizli` run.
  { at: ago(1.5), runId: demoRunId("UGURDESK-52"), role: "analyst", variantId: "analyst-desktop", driver: "openai-compat", model: "qwen3-coder-on-prem", tokensIn: 22_500, tokensOut: 3_200, cachePct: null, usd: null, dataClass: "gizli" },
  { at: ago(20.5), runId: demoRunId("UGURPAY-712"), role: "intake", variantId: "intake-default", driver: "anthropic-direct", model: "claude-haiku-4-5", tokensIn: 3_100, tokensOut: 400, cachePct: 0, usd: "0.01", dataClass: "dahili" },
  { at: ago(387), runId: demoRunId("UGURPAY-504"), role: "analyst", variantId: "analyst-desktop", driver: "aws-bedrock", model: "claude-opus-5", tokensIn: 31_000, tokensOut: 4_400, cachePct: 64, usd: "0.31", dataClass: "dahili" },
];

const VARIANT_ROWS: {
  id: string;
  role: "intake" | "analyst" | "engineer" | "dev_reviewer" | "test_designer";
  name: string;
  model: string;
  version: number;
  evalScore: number;
}[] = [
  { id: "analyst-web", role: "analyst", name: "web", model: "claude-opus-5", version: 7, evalScore: 94 },
  { id: "analyst-ios", role: "analyst", name: "mobile-ios", model: "claude-opus-5", version: 4, evalScore: 91 },
  { id: "analyst-desktop", role: "analyst", name: "desktop", model: "claude-opus-5", version: 3, evalScore: 88 },
  { id: "engineer-web", role: "engineer", name: "web", model: "claude-opus-5", version: 11, evalScore: 96 },
  { id: "engineer-ios", role: "engineer", name: "mobile-ios", model: "claude-opus-5", version: 5, evalScore: 89 },
  { id: "engineer-desktop", role: "engineer", name: "desktop", model: "claude-opus-5", version: 6, evalScore: 85 },
  { id: "reviewer-web", role: "dev_reviewer", name: "web", model: "claude-opus-5", version: 9, evalScore: 93 },
  { id: "intake-default", role: "intake", name: "default", model: "claude-haiku-4-5", version: 3, evalScore: 97 },
  { id: "testdes-web", role: "test_designer", name: "web", model: "claude-sonnet-5", version: 8, evalScore: 90 },
];

export const VARIANTS: Prisma.VariantCreateManyInput[] = VARIANT_ROWS.map((variant) => ({
  id: variant.id,
  role: variant.role,
  name: variant.name,
}));

export const VARIANT_VERSIONS: Prisma.VariantVersionCreateManyInput[] = VARIANT_ROWS.map(
  (variant, index) => ({
    variantId: variant.id,
    version: variant.version,
    model: variant.model,
    configJson: { temperature: 0.2, knowledgeRefs: ["analiz-sablonu.md", "bddk-uyum.md"] },
    evalScore: variant.evalScore,
    createdAt: ago(24 * (index + 3)),
  }),
);

export const SUBSCRIPTION_ACCOUNTS: Prisma.SubscriptionAccountCreateManyInput[] = [
  { accountId: "claude-sub-01", driver: "claude-sub", state: "ready", windowsJson: [{ kind: "5h", usedPct: 62, resetsAt: ago(-2).toISOString() }, { kind: "weekly", usedPct: 41, resetsAt: ago(-72).toISOString() }], lastUsedAt: ago(0.2) },
  { accountId: "claude-sub-02", driver: "claude-sub", state: "ready", windowsJson: [{ kind: "5h", usedPct: 88, resetsAt: ago(-1).toISOString() }, { kind: "weekly", usedPct: 67, resetsAt: ago(-72).toISOString() }], lastUsedAt: ago(0.4) },
  { accountId: "claude-sub-03", driver: "claude-sub", state: "exhausted", windowsJson: [{ kind: "5h", usedPct: 100, resetsAt: ago(-2.2).toISOString() }, { kind: "weekly", usedPct: 72, resetsAt: ago(-72).toISOString() }], lastUsedAt: ago(1.5) },
  { accountId: "gemini-sub-01", driver: "gemini-sub", state: "ready", windowsJson: [{ kind: "5h", usedPct: 34, resetsAt: ago(-3).toISOString() }, { kind: "weekly", usedPct: 28, resetsAt: ago(-72).toISOString() }], lastUsedAt: ago(6) },
  { accountId: "codex-sub-01", driver: "codex-sub", state: "disabled", windowsJson: [{ kind: "5h", usedPct: 0, resetsAt: ago(-4).toISOString() }, { kind: "weekly", usedPct: 12, resetsAt: ago(-72).toISOString() }], lastUsedAt: null },
];
