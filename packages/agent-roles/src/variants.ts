import { z } from "zod";
import { NonEmpty } from "@maestro/contracts";
import { MissingPromptError } from "./errors.js";
import { DEFAULT_PROMPT_TEXTS, type PromptTexts } from "./texts.js";
import { type AnalysisTemplate } from "./template.js";

/**
 * Variants (M38). A variant is a knowledge + wording overlay: the same roles,
 * addressed to a mobile team instead of a backend team. It never changes code
 * paths, only data — prompt texts and the analysis template.
 */

export const VARIANT_IDS = ["web", "mobile-ios", "mobile-android", "desktop", "backend"] as const;
export const VariantId = z.enum(VARIANT_IDS);
export type VariantId = z.infer<typeof VariantId>;

export const VariantTextOverrides = z.record(NonEmpty, z.string());
export type VariantTextOverrides = z.infer<typeof VariantTextOverrides>;

export interface RoleVariant {
  variantId: string;
  /** Overrides for keys that already exist in the defaults. */
  textOverrides: VariantTextOverrides;
  /** Optional per-variant analysis template (M108 + M83 pinning still apply). */
  template?: AnalysisTemplate;
}

/**
 * Merge overrides over the defaults.
 *
 * An override for a key the defaults do not carry is an error rather than a
 * silently ignored entry: a mistyped key would otherwise look configured while
 * the model kept reading the old wording — exactly the kind of "it was set, it
 * just did nothing" bug this project is built to avoid.
 */
export function resolveTexts(
  variant?: Pick<RoleVariant, "textOverrides">,
  base: PromptTexts = DEFAULT_PROMPT_TEXTS,
): PromptTexts {
  if (!variant) return base;
  const merged: Record<string, string> = { ...base };
  for (const [key, value] of Object.entries(variant.textOverrides)) {
    if (!(key in base)) throw new MissingPromptError(key);
    merged[key] = value;
  }
  return merged;
}

/** The template a run uses: the variant's, otherwise the project's. */
export function resolveTemplate(
  projectTemplate: AnalysisTemplate,
  variant?: RoleVariant,
): AnalysisTemplate {
  return variant?.template ?? projectTemplate;
}
