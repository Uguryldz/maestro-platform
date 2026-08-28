import { z } from "zod";
import {
  AnalysisDoc,
  EvidencePackage,
  GitSha,
  Locale,
  NonEmpty,
  RunId,
  TicketKey,
  type GateDecision,
  type ImpactCell,
} from "@maestro/contracts";
import { PublishRenderError } from "./errors.js";
import {
  DECISION_KEY_PREFIX,
  DOC_TITLE_KEY,
  IMPACT_SOURCE_KEY_PREFIX,
  MSG,
  RISK_TIER_KEY_PREFIX,
} from "./keys.js";
import { documentHeader, label } from "./md.js";
import type { Translate } from "./types.js";

/**
 * Release note draft (M91): produced from the ticket + merged diff by a cheap
 * model after merge. Publishing is a human decision, so the document says so.
 * Not in `packages/contracts` — see RAPOR.md interface request.
 */
export const ReleaseNoteDraft = z
  .object({
    templateVersion: NonEmpty,
    language: Locale,
    ticketKey: TicketKey,
    summary: NonEmpty,
    changes: z.array(NonEmpty).min(1),
    docUpdates: z.array(NonEmpty).default([]),
    mergeSha: GitSha,
    prId: z.number().int().positive().optional(),
  })
  .strict();
export type ReleaseNoteDraft = z.infer<typeof ReleaseNoteDraft>;

export interface DocContext {
  translate: Translate;
  /** Output language (M59/M104) — a project parameter, never a code default. */
  locale: Locale;
  runId: RunId;
  ticketKey: TicketKey;
}

/**
 * Analysis document (M43): the seven mandatory sections, in order, rendered
 * from the schema-validated document. Validation runs here too — a renderer
 * that accepts a six-section analysis is a fail-open path to a human gate.
 */
export function renderAnalysisMarkdown(input: AnalysisDoc, ctx: DocContext): string {
  const doc = AnalysisDoc.parse(input);
  assertLanguage(doc.language, ctx.locale);
  const { translate: tr, locale } = ctx;
  const md = documentHeader({
    translate: tr,
    locale,
    kind: "analysis",
    titleKey: DOC_TITLE_KEY.analysis,
    runId: ctx.runId,
    ticketKey: ctx.ticketKey,
    templateVersion: doc.templateVersion,
  });

  md.heading(2, label(tr, locale, MSG.sectionPurpose));
  md.paragraph(doc.purpose);

  md.heading(2, label(tr, locale, MSG.sectionScope));
  md.heading(3, label(tr, locale, MSG.labelScopeIncluded));
  md.bullets(doc.scope.included);
  md.heading(3, label(tr, locale, MSG.labelScopeExcluded));
  md.bullets(doc.scope.excluded, label(tr, locale, MSG.labelNone));

  md.heading(2, label(tr, locale, MSG.sectionImpact));
  md.bullets(doc.impactMatrix.map((cell) => impactLine(cell, ctx)));

  md.heading(2, label(tr, locale, MSG.sectionAcceptance));
  md.bullets(doc.acceptanceCriteria);

  // `prose`, not `paragraph`: these two are the free-text sections the model
  // writes at length, and it writes them in markdown. Escaping that markdown
  // published the asterisks and ran the bullets together (see `Markdown.prose`).
  md.heading(2, label(tr, locale, MSG.sectionUiApi));
  md.prose(doc.uiApiChanges);

  md.heading(2, label(tr, locale, MSG.sectionTestApproach));
  md.prose(doc.testApproach);

  /**
   * Risk reads as a STATEMENT, not as a record dump.
   *
   * Five `- **Label:** value` bullets in a row — "Risk katmanı: Orta", "Risk
   * gerekçesi: …" — is the shape of a debug print, and it is the section a
   * committee actually stops on. So the tier and its justification become the
   * sentence they always were, and only the three genuinely parallel facts
   * (risk, mitigation, rollback) stay a labelled list, because a reviewer does
   * compare those three against each other.
   */
  md.heading(2, label(tr, locale, MSG.sectionRisk));
  md.paragraph(
    `${label(tr, locale, MSG.labelRiskTier)}: ${label(tr, locale, `${RISK_TIER_KEY_PREFIX}${doc.riskTier}`)} — ${doc.riskReason}`,
  );
  md.field(label(tr, locale, MSG.labelRisk), doc.riskAndRollback.risk);
  md.field(label(tr, locale, MSG.labelMitigation), doc.riskAndRollback.mitigation);
  md.field(label(tr, locale, MSG.labelRollback), doc.riskAndRollback.rollback);

  md.heading(2, label(tr, locale, MSG.sectionClarifications));
  md.bullets(doc.clarificationsUsed, label(tr, locale, MSG.labelNone));

  return md.toString();
}

function impactLine(cell: ImpactCell, ctx: DocContext): string {
  const state = label(ctx.translate, ctx.locale, cell.impacted ? MSG.labelImpacted : MSG.labelNotImpacted);
  const source = label(ctx.translate, ctx.locale, `${IMPACT_SOURCE_KEY_PREFIX}${cell.source}`);
  return `${cell.appId} — ${state} (${source}): ${cell.summary}`;
}

/** Evidence package summary (M56/M57): what an auditor gets without the archive. */
export function renderEvidenceSummaryMarkdown(input: EvidencePackage, ctx: DocContext): string {
  const pkg = EvidencePackage.parse(input);
  if (pkg.runId !== ctx.runId || pkg.ticketKey !== ctx.ticketKey) {
    throw new PublishRenderError(
      `evidence package belongs to ${pkg.ticketKey}/${pkg.runId}, not ${ctx.ticketKey}/${ctx.runId}`,
    );
  }
  const { translate: tr, locale } = ctx;
  const md = documentHeader({
    translate: tr,
    locale,
    kind: "evidence_summary",
    titleKey: DOC_TITLE_KEY.evidence_summary,
    runId: ctx.runId,
    ticketKey: ctx.ticketKey,
    templateVersion: pkg.templateVersion,
  });
  md.field(label(tr, locale, MSG.labelEvidenceCreatedAt), pkg.createdAt);

  md.heading(2, label(tr, locale, MSG.sectionEvidenceFiles));
  md.bullets(pkg.files.map((f) => `${f.name} — ${String(f.bytes)} B · ${f.contentType} · sha256:${f.sha256}`));

  md.heading(2, label(tr, locale, MSG.sectionEvidenceApprovals));
  md.bullets(
    pkg.approvals.map((a) => approvalLine(a, ctx)),
    label(tr, locale, MSG.labelNone),
  );

  md.heading(2, label(tr, locale, MSG.sectionEvidenceRetention));
  md.field(label(tr, locale, MSG.labelRetentionYears), String(pkg.retentionYears));
  md.field(
    label(tr, locale, MSG.labelObjectLock),
    label(tr, locale, pkg.objectLock ? MSG.labelYes : MSG.labelNo),
  );

  return md.toString();
}

function approvalLine(decision: GateDecision, ctx: DocContext): string {
  const { translate: tr, locale } = ctx;
  const gate = label(tr, locale, `steps.${decision.step}`);
  const verdict = label(tr, locale, `${DECISION_KEY_PREFIX}${decision.decision}`);
  const signature = `${label(tr, locale, MSG.labelApproval)} #${String(decision.signatureSeq)}`;
  const reason = decision.reason ? ` — ${decision.reason}` : "";
  return `${gate} — ${verdict} · ${decision.actorUserId} · ${signature} · ${decision.at}${reason}`;
}

/** Post-merge release note DRAFT (M91) — publishing stays a human decision. */
export function renderReleaseNoteMarkdown(input: ReleaseNoteDraft, ctx: DocContext): string {
  const draft = ReleaseNoteDraft.parse(input);
  assertLanguage(draft.language, ctx.locale);
  if (draft.ticketKey !== ctx.ticketKey) {
    throw new PublishRenderError(`release note belongs to ${draft.ticketKey}, not ${ctx.ticketKey}`);
  }
  const { translate: tr, locale } = ctx;
  const md = documentHeader({
    translate: tr,
    locale,
    kind: "release_note",
    titleKey: DOC_TITLE_KEY.release_note,
    runId: ctx.runId,
    ticketKey: ctx.ticketKey,
    templateVersion: draft.templateVersion,
  });
  md.field(label(tr, locale, MSG.labelMergeSha), draft.mergeSha);
  if (draft.prId !== undefined) md.field(label(tr, locale, MSG.labelPullRequest), `#${String(draft.prId)}`);

  md.heading(2, label(tr, locale, MSG.sectionReleaseSummary));
  md.paragraph(draft.summary);

  md.heading(2, label(tr, locale, MSG.sectionReleaseChanges));
  md.bullets(draft.changes);

  md.heading(2, label(tr, locale, MSG.sectionReleaseDocUpdates));
  md.bullets(draft.docUpdates, label(tr, locale, MSG.labelNone));

  md.paragraph(label(tr, locale, MSG.noteReleaseDraft));
  return md.toString();
}

/**
 * The document's own language and the requested output language must agree:
 * rendering a Turkish body under English headings is exactly the kind of
 * silent mismatch M59/M104 exist to prevent.
 */
function assertLanguage(documentLanguage: Locale, requested: Locale): void {
  if (documentLanguage !== requested) {
    throw new PublishRenderError(
      `document language "${documentLanguage}" does not match the requested output language "${requested}"`,
    );
  }
}
