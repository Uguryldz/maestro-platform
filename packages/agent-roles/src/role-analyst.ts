import type { DataClass } from "@maestro/contracts";
import type { LlmPort } from "@maestro/ports";
import type { AnalysisContext } from "./context.js";
import { buildAnalysisPrompt } from "./prompt.js";
import { type RoleResult, runRole } from "./run.js";
import { type AnalysisOutput, analysisSchemaName, buildAnalysisSchema } from "./schema-builder.js";
import type { AnalysisTemplate } from "./template.js";
import { DEFAULT_PROMPT_TEXTS, type PromptTexts } from "./texts.js";
import { validateAnalysis } from "./validate.js";

/**
 * Step 3 — the analyst (M43/M108/M109).
 *
 * Nothing here knows what a section is called or how many there are. The
 * template decides the schema, the prompt and the validation; this function
 * only wires the three together, which is why adding a section in Studio needs
 * no code change.
 */

export interface AnalystArgs {
  llm: LlmPort;
  template: AnalysisTemplate;
  context: AnalysisContext;
  variantId: string;
  dataClass: DataClass;
  texts?: PromptTexts;
}

export function runAnalyst(args: AnalystArgs): Promise<RoleResult<AnalysisOutput>> {
  const texts = args.texts ?? DEFAULT_PROMPT_TEXTS;
  return runRole<AnalysisOutput>({
    llm: args.llm,
    role: "analyst",
    variantId: args.variantId,
    dataClass: args.dataClass,
    schemaName: analysisSchemaName(args.template),
    schema: buildAnalysisSchema(args.template),
    prompt: buildAnalysisPrompt({ template: args.template, context: args.context, texts }),
    check: (value) =>
      validateAnalysis({ template: args.template, context: args.context, value, texts }),
    texts,
  });
}
