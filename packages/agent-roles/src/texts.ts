import promptsTr from "../data/prompts.tr.json" with { type: "json" };
import { MissingPromptError } from "./errors.js";

/**
 * Prompt and deficiency texts live in `data/*.json`, never inline in code.
 * Two reasons: M59 (model-facing text is Turkish while code stays English) and
 * M38 (a variant overrides wording without touching a single source file).
 */
export type PromptTexts = Readonly<Record<string, string>>;

export const DEFAULT_PROMPT_TEXTS: PromptTexts = promptsTr;

/** Look up a text and interpolate `{name}` placeholders. Missing key throws. */
export function text(
  texts: PromptTexts,
  key: string,
  params: Readonly<Record<string, string>> = {},
): string {
  const template = texts[key];
  if (template === undefined) throw new MissingPromptError(key);
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => params[name] ?? whole);
}

/** Keys the defaults carry — used by the parity test and by Studio tooling. */
export function promptKeys(texts: PromptTexts = DEFAULT_PROMPT_TEXTS): string[] {
  return Object.keys(texts).sort();
}
