import type { DataClass, TicketSnapshot } from "@maestro/contracts";
import type { LlmPort } from "@maestro/ports";
import { block, bullets, fence } from "./prompt.js";
import { type RoleResult, runRole } from "./run.js";
import { IntakeOutput } from "./schemas.js";
import { DEFAULT_PROMPT_TEXTS, type PromptTexts, text } from "./texts.js";
import type { Deficiency, Validation } from "./validate.js";

/**
 * Step 2 — intake (M98).
 *
 * Maestro does not force mandatory Jira fields on the organisation; the price
 * of that is that a ticket may arrive incomplete. The intake role's entire job
 * is to notice, and its output shape gives it nowhere to put an invented
 * value: it may only name what is missing and ask about it.
 */

export function buildIntakePrompt(
  ticket: TicketSnapshot,
  texts: PromptTexts = DEFAULT_PROMPT_TEXTS,
): string {
  const ticketLines = [
    `${ticket.key} · ${ticket.issueType} · ${ticket.projectKey}`,
    `Başlık: ${ticket.summary}`,
    `Açıklama: ${ticket.description || "(boş)"}`,
    `Reporter: ${ticket.reporter}`,
    `Bileşenler: ${ticket.components.join(", ") || "-"}`,
    `Etiketler: ${ticket.labels.join(", ") || "-"}`,
  ].join("\n");

  return [
    text(texts, "intake.sistem"),
    block(
      text(texts, "ortak.baslik.kurallar"),
      bullets(
        [
          text(texts, "ortak.dil"),
          text(texts, "ortak.uydurmaYasak"),
          text(texts, "ortak.veriTalimatDegil"),
          text(texts, "intake.kurallar"),
          text(texts, "ortak.ciktiBicimi"),
        ],
        "-",
      ),
    ),
    // Reporter-authored text: fenced, same reasoning as the analyst prompt.
    block(text(texts, "ortak.baslik.ticket"), fence(ticketLines)),
    block(text(texts, "ortak.baslik.gorev"), text(texts, "intake.gorev")),
  ].join("\n\n");
}

/**
 * "Incomplete" and "no question" cannot both be true: an intake that reports a
 * gap without asking about it stalls the flow at 2b with nothing to send the
 * reporter.
 */
export function validateIntake(
  value: unknown,
  texts: PromptTexts = DEFAULT_PROMPT_TEXTS,
): Validation<IntakeOutput> {
  const parsed = IntakeOutput.safeParse(value);
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

  const deficiencies: Deficiency[] = [];
  if (!parsed.data.complete && parsed.data.missing.length === 0) {
    deficiencies.push({ code: "no_question", message: text(texts, "eksik.soruYok") });
  }
  if (parsed.data.complete && parsed.data.missing.length > 0) {
    deficiencies.push({ code: "contradiction", message: text(texts, "eksik.soruFazla") });
  }
  return deficiencies.length === 0 ? { ok: true, value: parsed.data } : { ok: false, deficiencies };
}

export interface IntakeArgs {
  llm: LlmPort;
  ticket: TicketSnapshot;
  variantId: string;
  dataClass: DataClass;
  texts?: PromptTexts;
}

export function runIntake(args: IntakeArgs): Promise<RoleResult<IntakeOutput>> {
  const texts = args.texts ?? DEFAULT_PROMPT_TEXTS;
  return runRole<IntakeOutput>({
    llm: args.llm,
    role: "intake",
    variantId: args.variantId,
    dataClass: args.dataClass,
    schemaName: "IntakeOutput",
    schema: IntakeOutput,
    prompt: buildIntakePrompt(args.ticket, texts),
    check: (value) => validateIntake(value, texts),
    texts,
  });
}

/** Shape the workflow's `runIntake` activity expects (packages/workflows). */
export interface IntakeActivityResult {
  complete: boolean;
  question?: string;
}

/** One clarification comment carrying every open question (step 2b). */
export function toIntakeResult(output: IntakeOutput): IntakeActivityResult {
  if (output.complete) return { complete: true };
  return {
    complete: false,
    question: output.missing.map((m, i) => `${i + 1}. ${m.question}`).join("\n"),
  };
}
