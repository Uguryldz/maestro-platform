import { z } from "zod";
import { AppId, Locale, NonEmpty, RiskTier } from "./common.js";

/** One row of the impact matrix. Cross-app impact is judged from repo cards (M100). */
export const ImpactCell = z.object({
  appId: AppId,
  impacted: z.boolean(),
  summary: NonEmpty.max(500),
  source: z.enum(["primary_repo_discovery", "repo_card"]),
});
export type ImpactCell = z.infer<typeof ImpactCell>;

/**
 * Analysis document (M43): seven mandatory sections, validated fail-closed —
 * a missing section never reaches a human gate. Template version is pinned
 * per run (M83); language follows project parameter (M59/M104).
 */
export const AnalysisDoc = z
  .object({
    templateVersion: NonEmpty,
    language: Locale,
    purpose: NonEmpty, // 1. amaç / iş değeri
    scope: z.object({
      included: z.array(NonEmpty).min(1),
      excluded: z.array(NonEmpty).default([]),
    }), // 2. kapsam
    impactMatrix: z.array(ImpactCell).min(1), // 3. etki analizi
    acceptanceCriteria: z.array(NonEmpty).min(1), // 4. kabul kriterleri
    uiApiChanges: NonEmpty, // 5. ekran / API değişiklikleri
    testApproach: NonEmpty, // 6. test yaklaşımı
    riskAndRollback: z.object({
      risk: NonEmpty,
      mitigation: NonEmpty,
      rollback: NonEmpty,
    }), // 7. risk ve geri dönüş planı
    riskTier: RiskTier,
    riskReason: NonEmpty,
    clarificationsUsed: z.array(NonEmpty).default([]),
  })
  .strict();
export type AnalysisDoc = z.infer<typeof AnalysisDoc>;
