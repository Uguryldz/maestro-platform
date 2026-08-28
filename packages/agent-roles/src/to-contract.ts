import { AnalysisDoc, type ImpactCell, type Locale } from "@maestro/contracts";
import { TemplateError } from "./errors.js";
import { renderAnalysisMarkdown, renderSectionValue } from "./render.js";
import type { AnalysisOutput } from "./schema-builder.js";
import type { AnalysisTemplate, ContractField, TemplateSection } from "./template.js";
import { DEFAULT_PROMPT_TEXTS, type PromptTexts } from "./texts.js";

/**
 * Bridge between the designed template (M108) and the frozen `AnalysisDoc`
 * contract (M43).
 *
 * The contract is the FLOOR: seven fields every analysis must be able to
 * produce, because the workflow, the fan-out and the evidence package read
 * them. A template may carry any number of sections beyond it — those travel
 * in `TemplatedAnalysis` and reach the published document, not the contract.
 */

export interface TemplatedAnalysis {
  templateId: string;
  templateVersion: string;
  locale: Locale;
  sections: Record<string, unknown>;
  riskTier: AnalysisOutput["riskTier"];
  riskReason: string;
  clarificationsUsed: string[];
  markdown: string;
}

export function toTemplatedAnalysis(
  template: AnalysisTemplate,
  output: AnalysisOutput,
  texts: PromptTexts = DEFAULT_PROMPT_TEXTS,
): TemplatedAnalysis {
  return {
    templateId: template.templateId,
    templateVersion: template.version,
    locale: template.locale,
    sections: output.sections,
    riskTier: output.riskTier,
    riskReason: output.riskReason,
    clarificationsUsed: output.clarificationsUsed,
    markdown: renderAnalysisMarkdown(template, output, texts),
  };
}

function bound(template: AnalysisTemplate, field: ContractField): TemplateSection {
  const section = template.sections.find((s) => s.contractField === field);
  if (!section) {
    throw new TemplateError(
      template.templateId,
      `no section bound to contract field "${field}" — AnalysisDoc cannot be produced`,
    );
  }
  return section;
}

function requireSubKeys(
  template: AnalysisTemplate,
  section: TemplateSection,
  keys: readonly string[],
): void {
  const present = (section.subFields ?? section.subLists ?? []).map((s) => s.key);
  const missing = keys.filter((k) => !present.includes(k));
  if (missing.length > 0) {
    throw new TemplateError(
      template.templateId,
      `section "${section.key}" is bound to a contract field and must define sub-keys ${keys.join(", ")} (missing: ${missing.join(", ")})`,
    );
  }
}

/**
 * Project the templated output onto the contract, then validate it against the
 * frozen schema — so a template that drifts fails here loudly instead of
 * producing a half-filled `AnalysisDoc` downstream.
 */
export function toAnalysisDoc(
  template: AnalysisTemplate,
  output: AnalysisOutput,
  texts: PromptTexts = DEFAULT_PROMPT_TEXTS,
): AnalysisDoc {
  const value = (field: ContractField): { section: TemplateSection; raw: unknown } => {
    const section = bound(template, field);
    return { section, raw: output.sections[section.key] };
  };

  const scope = value("scope");
  requireSubKeys(template, scope.section, ["included", "excluded"]);
  const scopeValue = (scope.raw ?? {}) as Record<string, string[]>;

  const risk = value("riskAndRollback");
  requireSubKeys(template, risk.section, ["risk", "mitigation", "rollback"]);
  const riskValue = (risk.raw ?? {}) as Record<string, string>;

  const ui = value("uiApiChanges");

  return AnalysisDoc.parse({
    templateVersion: template.version,
    language: template.locale,
    purpose: value("purpose").raw,
    scope: {
      included: scopeValue["included"] ?? [],
      excluded: scopeValue["excluded"] ?? [],
    },
    impactMatrix: value("impactMatrix").raw as ImpactCell[],
    acceptanceCriteria: value("acceptanceCriteria").raw as string[],
    // An optional section that is bound to a required contract field renders to
    // the template's own "no change" wording rather than to an empty string.
    uiApiChanges: renderSectionValue(ui.section, ui.raw, texts),
    testApproach: renderSectionValue(value("testApproach").section, value("testApproach").raw, texts),
    riskAndRollback: {
      risk: riskValue["risk"] ?? "",
      mitigation: riskValue["mitigation"] ?? "",
      rollback: riskValue["rollback"] ?? "",
    },
    riskTier: output.riskTier,
    riskReason: output.riskReason,
    clarificationsUsed: output.clarificationsUsed,
  });
}
