import type { DataClass, TicketSnapshot } from "@maestro/contracts";
import type { LlmPort } from "@maestro/ports";
import type { NamedDoc } from "./context.js";
import { block, bullets } from "./prompt.js";
import { type RoleResult, runRole } from "./run.js";
import { BLOCKING_SEVERITIES, DevReviewOutput } from "./schemas.js";
import { DEFAULT_PROMPT_TEXTS, type PromptTexts, text } from "./texts.js";
import type { Deficiency, Validation } from "./validate.js";

/**
 * Step 6c — dev reviewer.
 *
 * "Real diff review" is enforced, not requested: every finding must name a
 * file that the reviewed diff actually touches. A model that invents
 * `src/service.ts` because such a file usually exists gets its answer refused
 * with the file name quoted back at it.
 */

const DIFF_FILE = /^(?:\+\+\+ b\/|--- a\/|diff --git a\/\S+ b\/)(\S+)$/gm;

export function diffFiles(diff: string): string[] {
  const files = new Set<string>();
  for (const match of diff.matchAll(DIFF_FILE)) {
    const file = match[1];
    if (file && file !== "/dev/null") files.add(file);
  }
  return [...files];
}

export interface DevReviewContext {
  ticket: TicketSnapshot;
  /** Unified diff of the branch under review. */
  diff: string;
  acceptanceCriteria: string[];
  codingStandards: NamedDoc[];
}

export function buildDevReviewPrompt(
  context: DevReviewContext,
  texts: PromptTexts = DEFAULT_PROMPT_TEXTS,
): string {
  return [
    text(texts, "devReviewer.sistem"),
    block(
      text(texts, "ortak.baslik.kurallar"),
      bullets(
        [
          text(texts, "ortak.dil"),
          text(texts, "ortak.uydurmaYasak"),
          text(texts, "devReviewer.kurallar"),
          text(texts, "ortak.ciktiBicimi"),
        ],
        "-",
      ),
    ),
    block(
      text(texts, "ortak.baslik.ticket"),
      `${context.ticket.key} · ${context.ticket.summary}`,
    ),
    block(
      text(texts, "testDesigner.baslik.kabulKriterleri"),
      bullets(
        context.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`),
        text(texts, "ortak.baglamBos"),
      ),
    ),
    block(
      text(texts, "ortak.baslik.kodlamaStandartlari"),
      bullets(
        context.codingStandards.map((d) => `${d.name}: ${d.text}`),
        text(texts, "ortak.baglamBos"),
      ),
    ),
    block(text(texts, "devReviewer.baslik.diff"), context.diff),
    block(text(texts, "ortak.baslik.gorev"), text(texts, "devReviewer.gorev")),
  ].join("\n\n");
}

export function validateDevReview(
  value: unknown,
  context: DevReviewContext,
  texts: PromptTexts = DEFAULT_PROMPT_TEXTS,
): Validation<DevReviewOutput> {
  const parsed = DevReviewOutput.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      deficiencies: parsed.error.issues.map((i) => ({
        code: "schema",
        message: text(texts, "eksik.semaHatasi", {
          yol: i.path.map(String).join(".") || "<kök>",
          mesaj: i.message,
        }),
      })),
    };
  }

  const files = new Set(diffFiles(context.diff));
  const deficiencies: Deficiency[] = [];
  for (const finding of parsed.data.findings) {
    if (!files.has(finding.file.trim())) {
      deficiencies.push({
        code: "finding_off_diff",
        message: text(texts, "eksik.bulguDosyaYok", { dosya: finding.file }),
      });
    }
  }

  const blocking = parsed.data.findings.some((f) => BLOCKING_SEVERITIES.includes(f.severity));
  if (blocking && parsed.data.approved) {
    deficiencies.push({
      code: "approval_contradiction",
      message: text(texts, "eksik.onayCelismesi"),
    });
  }
  return deficiencies.length === 0 ? { ok: true, value: parsed.data } : { ok: false, deficiencies };
}

export interface DevReviewArgs {
  llm: LlmPort;
  context: DevReviewContext;
  variantId: string;
  dataClass: DataClass;
  texts?: PromptTexts;
}

export function runDevReviewer(args: DevReviewArgs): Promise<RoleResult<DevReviewOutput>> {
  const texts = args.texts ?? DEFAULT_PROMPT_TEXTS;
  return runRole<DevReviewOutput>({
    llm: args.llm,
    role: "dev_reviewer",
    variantId: args.variantId,
    dataClass: args.dataClass,
    schemaName: "DevReviewOutput",
    schema: DevReviewOutput,
    prompt: buildDevReviewPrompt(args.context, texts),
    check: (value) => validateDevReview(value, args.context, texts),
    texts,
  });
}

/** Shape the workflow's `reviewDiff` / `reviewTests` activities expect. */
export interface ReviewActivityResult {
  approved: boolean;
  findings: string[];
}

export function toReviewResult(output: DevReviewOutput): ReviewActivityResult {
  return {
    approved: output.approved,
    findings: output.findings.map(
      (f) => `[${f.severity}] ${f.file}:${f.locator} — ${f.problem} → ${f.suggestion}`,
    ),
  };
}
