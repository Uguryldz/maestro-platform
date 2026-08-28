import { PublishDocKind, RiskTier, STEP_IDS } from "@maestro/contracts";

/**
 * Every message key this package emits (M104). User-facing text is NEVER
 * written in code: the renderers only ever hand these keys to `Translate`.
 * The tr+en values live in RAPOR.md until the orchestrator adds them to
 * `packages/config/locales` (this package must not edit the catalog).
 */
export const MSG = {
  titleAnalysis: "publish.title.analysis",
  titleEvidence: "publish.title.evidence_summary",
  titleReleaseNote: "publish.title.release_note",

  metaTemplateVersion: "publish.meta.template_version",
  metaTicket: "publish.meta.ticket",
  metaRun: "publish.meta.run",

  sectionPurpose: "publish.section.purpose",
  sectionScope: "publish.section.scope",
  sectionImpact: "publish.section.impact",
  sectionAcceptance: "publish.section.acceptance",
  sectionUiApi: "publish.section.ui_api",
  sectionTestApproach: "publish.section.test_approach",
  sectionRisk: "publish.section.risk",
  sectionClarifications: "publish.section.clarifications",

  labelScopeIncluded: "publish.label.scope_included",
  labelScopeExcluded: "publish.label.scope_excluded",
  labelRisk: "publish.label.risk",
  labelMitigation: "publish.label.mitigation",
  labelRollback: "publish.label.rollback",
  labelRiskTier: "publish.label.risk_tier",
  labelRiskReason: "publish.label.risk_reason",
  labelImpacted: "publish.label.impacted",
  labelNotImpacted: "publish.label.not_impacted",
  labelNone: "publish.label.none",

  sectionEvidenceFiles: "publish.section.evidence_files",
  sectionEvidenceApprovals: "publish.section.evidence_approvals",
  sectionEvidenceRetention: "publish.section.evidence_retention",
  labelEvidenceCreatedAt: "publish.label.created_at",
  labelRetentionYears: "publish.label.retention_years",
  labelObjectLock: "publish.label.object_lock",
  labelYes: "publish.label.yes",
  labelNo: "publish.label.no",
  labelApproval: "publish.label.approval",

  sectionReleaseSummary: "publish.section.release_summary",
  sectionReleaseChanges: "publish.section.release_changes",
  sectionReleaseDocUpdates: "publish.section.release_doc_updates",
  labelMergeSha: "publish.label.merge_sha",
  labelPullRequest: "publish.label.pull_request",
  noteReleaseDraft: "publish.note.release_draft",
} as const satisfies Record<string, string>;

/** Source of an impact-matrix row (M100); one key per `ImpactCell.source`. */
export const IMPACT_SOURCE_KEY_PREFIX = "publish.impact_source.";
/** Risk tier label (M51); one key per `RiskTier`. */
export const RISK_TIER_KEY_PREFIX = "publish.risk_tier.";
/** Gate decision label; one key per `GateDecision.decision`. */
export const DECISION_KEY_PREFIX = "publish.decision.";

export const IMPACT_SOURCES = ["primary_repo_discovery", "repo_card"] as const;
export const DECISIONS = ["approve", "reject"] as const;

export const DOC_TITLE_KEY: Record<PublishDocKind, string> = {
  analysis: MSG.titleAnalysis,
  evidence_summary: MSG.titleEvidence,
  release_note: MSG.titleReleaseNote,
};

/**
 * Full key list, dynamic families expanded. The composition root can assert
 * catalog completeness against it BEFORE a run publishes anything, instead of
 * discovering a missing key when the analysis is already at a human gate.
 */
export function publishMessageKeys(): string[] {
  return [
    ...Object.values(MSG),
    ...IMPACT_SOURCES.map((s) => `${IMPACT_SOURCE_KEY_PREFIX}${s}`),
    ...RiskTier.options.map((r) => `${RISK_TIER_KEY_PREFIX}${r}`),
    ...DECISIONS.map((d) => `${DECISION_KEY_PREFIX}${d}`),
    // Gate names come from the catalog family the workflow already owns.
    ...STEP_IDS.map((id) => `steps.${id}`),
  ].sort();
}
