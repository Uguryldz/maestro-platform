import {
  type AnalysisContext,
  type AnalysisOutput,
  type AnalysisTemplate,
  DEFAULT_ANALYSIS_TEMPLATE,
  type IntakeOutput,
  runAnalyst,
  runIntake,
  toAnalysisDoc,
} from "@maestro/agent-roles";
import type { AnalysisDoc, DataClass, TicketSnapshot } from "@maestro/contracts";
import type { LlmOutcome, LlmPort } from "@maestro/ports";
import type { z } from "zod";

/**
 * The pilot's analysis step, done by the REAL agent-roles analyst.
 *
 * This is what makes "analizi hangi AI agent yapacaksa o, knowledge + variant
 * ile" real (Uğur): the seven-section validation is no longer a hand-rolled Zod
 * in run.ts. It comes from a real analysis TEMPLATE (M43/M108/M109 —
 * `DEFAULT_ANALYSIS_TEMPLATE`), a real `AnalysisContext` and a real VARIANT,
 * exactly the inputs `runAnalyst` was built to take. Adding a section in Studio
 * would change what the pilot validates against with no code change here.
 *
 * The template's sections are bound to the frozen `AnalysisDoc` contract, so
 * `toAnalysisDoc` projects the analyst's output onto the same `AnalysisDoc` the
 * rest of the pilot already consumes (the Jira comment, the Word/PDF, the
 * engineering step). Nothing downstream changes shape.
 */

/**
 * The analysis template the pilot validates against.
 *
 * It is the corporate default straight from agent-roles: the seven M43 sections,
 * each bound to its `AnalysisDoc` contract field, plus M109's `Kaynaklar`
 * (source_list) and `Netleştirilecek açık maddeler` (open_items). Studio would
 * edit this shape in production (M108); the pilot pins the default so the
 * analyst validates against real sections rather than an ad-hoc schema.
 */
export function pilotAnalysisTemplate(): AnalysisTemplate {
  return DEFAULT_ANALYSIS_TEMPLATE;
}

/**
 * The SAFE Studio overlay for the analysis template (M108, "güvenli overlay").
 *
 * Studio's template designer publishes section rows to the DB
 * (`AnalysisTemplateVersion`), but the engine's template is
 * `DEFAULT_ANALYSIS_TEMPLATE`, whose sections carry CONTRACT BINDINGS
 * (`contractField`, `subFields`, `columns`, `format`) that the DB shape does not
 * — swapping the whole template for the DB rows would break the fail-closed
 * projection onto the frozen `AnalysisDoc`. So the DB may only OVERLAY the two
 * prose fields a document owner actually edits: a section's `title` and its
 * `aiInstruction` (the Turkish instruction the model reads verbatim, M59).
 * Everything structural stays the engine's.
 */
export interface AnalysisTemplateOverlaySection {
  key: string;
  title?: string;
  aiInstruction?: string;
}

export interface AnalysisTemplateOverlay {
  sections: readonly AnalysisTemplateOverlaySection[];
}

/** Loader shape the composition root wires (lazy — read PER RUN, restart-free). */
export type AnalysisTemplateOverlayLoader = () => Promise<AnalysisTemplateOverlay | null>;

export interface OverlayedAnalysisTemplate {
  template: AnalysisTemplate;
  /**
   * Overlay section keys the engine template does not carry. NOT silently
   * dropped: the caller logs each one ("şablonda eşleşmeyen bölüm: X — motor
   * yapısı sabit") so a designer who added a section in Studio learns the
   * engine's structure did not grow a slot for it.
   */
  unmatched: string[];
}

/**
 * Apply a Studio overlay onto the engine template, PURE and fail-safe.
 *
 * Only `title` and `aiInstruction` of a key-matched section are replaced, and
 * only with a non-empty value (an empty DB cell can never blank out a prompt —
 * both fields are NonEmpty in the template schema). Bindings, format, columns,
 * subFields, required, examples: untouched. `null` overlay = the base template
 * byte-for-byte (`template === base`).
 */
export function applyTemplateOverlay(
  overlay: AnalysisTemplateOverlay | null,
  base: AnalysisTemplate = DEFAULT_ANALYSIS_TEMPLATE,
): OverlayedAnalysisTemplate {
  if (overlay === null || overlay.sections.length === 0) {
    return { template: base, unmatched: [] };
  }

  const byKey = new Map(overlay.sections.map((s) => [s.key, s]));
  const sections = base.sections.map((section) => {
    const over = byKey.get(section.key);
    if (over === undefined) return section;
    const title = over.title?.trim();
    const aiInstruction = over.aiInstruction?.trim();
    return {
      ...section,
      ...(title !== undefined && title !== "" ? { title } : {}),
      ...(aiInstruction !== undefined && aiInstruction !== "" ? { aiInstruction } : {}),
    };
  });

  const known = new Set(base.sections.map((s) => s.key));
  const unmatched = [...new Set(overlay.sections.map((s) => s.key).filter((key) => !known.has(key)))];

  return { template: { ...base, sections }, unmatched };
}

/**
 * Everything the analyst is allowed to know for this run.
 *
 * Today the pilot only has the live Jira ticket, so the ticket is the only
 * populated part of the context and the analyst may only cite it (its reference
 * index is the ticket key + parent key). Discovery, repo cards, knowledge docs,
 * coding standards, example analyses and clarification rounds are the M38/M100
 * inputs the analyst is designed to lean on — they are left EMPTY here, wired
 * the moment the pilot populates them, and every empty one is a deliberate
 * gap rather than a silent omission.
 *
 * TODO(repo-card/knowledge): once the pilot runs repo discovery (step 3o) and
 * loads the M38 knowledge pack for `ugurpay`, fill `discovery.files/modules`,
 * `knowledge.repoCards` (so the impact matrix may cite `repo_card`) and
 * `knowledge.knowledgeDocs`. Until then the analyst is constrained to
 * ticket-sourced claims, which is the honest posture: it cannot cite a repo
 * file it was never shown.
 */
/**
 * One human ticket comment carried into the intake/analysis context, so the
 * answers a reporter writes after an İADE (return) are actually SEEN when the
 * ticket comes back to the bot — this is what breaks the return loop.
 */
export interface TicketComment {
  author: string;
  text: string;
}

/**
 * Render the human comments as the plain-text block appended to a CLONED
 * ticket description for the intake role (the contracts are frozen, but an
 * object copy is free). Exported for tests.
 */
export function appendCommentsToDescription(
  description: string,
  comments: readonly TicketComment[],
): string {
  if (comments.length === 0) return description;
  const lines = comments.map((c) => `- ${c.author}: ${c.text}`);
  return `${description}\n\n--- Yorumlar (ticket üzerindeki insan yanıtları) ---\n${lines.join("\n")}`;
}

export function buildAnalysisContext(
  ticket: TicketSnapshot,
  guidance: readonly { title: string; content: string }[] = [],
  attachments: readonly { name: string; kind: string; content: string | null }[] = [],
  comments: readonly TicketComment[] = [],
): AnalysisContext {
  // Turn attachments into named docs the analyst can read. A text attachment
  // carries its content; an image/PDF carries a note that it exists (its bytes
  // are not parsed yet), so the analyst can say "review the attached screenshot"
  // rather than silently ignoring it.
  const attachmentDocs = attachments.map((a) => ({
    name: `ek: ${a.name}`,
    text:
      a.content !== null
        ? a.content
        : `(${a.kind} eki — içeriği metin olarak okunamadı; analizde 'ekli ${a.name} incelenmeli' olarak belirt)`,
  }));
  return {
    ticket,
    // TODO(repo-card/knowledge): populated from step 3o repo discovery.
    discovery: { appId: ticket.projectKey, files: [], modules: [] },
    // The operator's uploaded "öğren" notes plus the ticket's attachments become
    // knowledge docs the analyst leans on. repoCards/coding standards/example
    // analyses are still the M38/M100 inputs left for later.
    knowledge: {
      repoCards: [],
      knowledgeDocs: [...guidance.map((g) => ({ name: g.title, text: g.content })), ...attachmentDocs],
      codingStandards: [],
      exampleAnalyses: [],
    },
    // Clarification rounds, replayed from the ticket's HUMAN comments (clarify-
    // resume lite): when a returned ticket comes back to the bot, the answers
    // the reporter wrote as comments land here, so the analyst reads them (the
    // prompt renders each round) and may cite them (`clarification` refs). An
    // un-returned ticket simply has no human comments — empty, as before.
    clarifications: comments.map((c, index) => ({
      id: `yorum-${index + 1}`,
      question: `Ticket yorumu (${c.author})`,
      answer: c.text,
    })),
  };
}

/**
 * The analyst ran and produced a validated document — both the MASKED copy (safe
 * to persist/journal, M20/M82) and the `display` copy with the real values
 * re-inserted for the human-facing Jira comment and the Word/PDF.
 */
export interface AnalysisResult {
  /** Real values re-inserted — what a reviewer reads and what the docs render. */
  display: AnalysisDoc;
  /** The masked document — the copy an artifact store or journal may keep. */
  masked: AnalysisDoc;
  attempts: number;
}

/**
 * A non-ok analyst outcome the pilot must surface as a step message rather than
 * a stack trace (mirrors the old `think` helper's handling of the same states).
 */
export class AnalysisHaltedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalysisHaltedError";
  }
}

/**
 * Wrap an `LlmPort` so the pilot can recover the `unmask` function the gateway
 * returns on a masked route.
 *
 * `runAnalyst` is typed against `LlmPort`, whose `ok` branch carries only the
 * MASKED value — the gateway widens that branch with `unmask` (M20/M82), but a
 * caller typed as `LlmPort` never sees it, so `runAnalyst`'s `RoleResult` drops
 * it. The pilot still needs the real values for the reviewer-facing comment and
 * the docs, so this thin proxy captures the last `unmask` off each
 * `generateObject` call without touching the frozen port. When nothing was
 * masked, `unmask` stays the identity, so the display copy equals the masked
 * copy.
 */
function captureUnmask(llm: LlmPort): { port: LlmPort; unmask: <R>(value: R) => R } {
  let last: (<R>(value: R) => R) | undefined;
  const port: LlmPort = {
    async generateObject<T>(
      req: Parameters<LlmPort["generateObject"]>[0],
      schema: z.ZodType<T>,
    ): Promise<LlmOutcome<T>> {
      const outcome = await llm.generateObject(req, schema);
      if (outcome.status === "ok") {
        const un = (outcome as { unmask?: <R>(value: R) => R }).unmask;
        if (un) last = un;
      }
      return outcome;
    },
    agentSession: (opts) => llm.agentSession(opts),
  };
  return {
    port,
    unmask: <R>(value: R): R => (last ? last(value) : value),
  };
}

export interface ProduceAnalysisArgs {
  llm: LlmPort;
  ticket: TicketSnapshot;
  variantId: string;
  dataClass: DataClass;
  template?: AnalysisTemplate;
  /**
   * The enabled analysis-guidance notes ("öğren") — injected into the analyst's
   * context as knowledge docs, so the operator's uploaded knowledge shapes the
   * analysis. Empty/absent = the analyst leans only on the ticket, as before.
   */
  guidance?: readonly { title: string; content: string }[];
  /**
   * The ticket's attachments. Text attachments carry their content; images/PDFs
   * carry only a name (bytes not parsed here). Given to the analyst so a
   * screenshot/spec-PDF ticket is not analysed with only its text fields.
   */
  attachments?: readonly { name: string; kind: string; content: string | null }[];
  /**
   * The ticket's recent HUMAN comments (bot/command comments already filtered
   * by the caller). Mapped into the context's clarification rounds so an İADE
   * answer written on the ticket is read by the analyst. Empty/absent = none.
   */
  comments?: readonly TicketComment[];
}

/**
 * Run the real analyst and hand back the `AnalysisDoc` the pilot flow consumes.
 *
 * Fail-closed is unchanged: a template-validation failure (a missing section, a
 * fabricated source, a non-answer body) is a `RoleOutputError` thrown from
 * `runAnalyst` after the single repair round, so an analysis that misses a
 * section never reaches the gate — the same guarantee the old hand-rolled Zod
 * gave, now driven by the real template. The three non-ok LLM states (queued /
 * degraded / blocked) become an `AnalysisHaltedError` with the same wording the
 * old `think` helper produced.
 */
export async function produceAnalysis(args: ProduceAnalysisArgs): Promise<AnalysisResult> {
  const template = args.template ?? pilotAnalysisTemplate();
  const context = buildAnalysisContext(
    args.ticket,
    args.guidance ?? [],
    args.attachments ?? [],
    args.comments ?? [],
  );
  const captured = captureUnmask(args.llm);

  const result = await runAnalyst({
    llm: captured.port,
    template,
    context,
    variantId: args.variantId,
    dataClass: args.dataClass,
  });

  if (result.status !== "ok") {
    throw new AnalysisHaltedError(
      result.status === "queued"
        ? `model kuyruğa alındı (kota) — ${result.resumeAt}`
        : `model çağrısı '${result.status}': ${result.messageKey}`,
    );
  }

  // The RoleResult value is the MASKED output; the display copy re-inserts the
  // real values with the captured unmask. Both are projected onto the SAME
  // frozen AnalysisDoc via `toAnalysisDoc` (M43), so the seven-section
  // validation the pilot relies on now comes from the template.
  const maskedOutput: AnalysisOutput = result.value;
  const displayOutput = captured.unmask(maskedOutput);

  return {
    masked: toAnalysisDoc(template, maskedOutput),
    display: toAnalysisDoc(template, displayOutput),
    attempts: result.attempts,
  };
}

/**
 * The pilot's CLARIFY (intake) gate — the real agent-roles intake role (M98).
 *
 * Runs BEFORE `produceAnalysis`. Maestro does not force mandatory Jira fields on
 * the organisation, so a ticket can arrive too thin to analyse. The intake
 * role's output shape gives it nowhere to invent a value: it can only judge the
 * ticket `complete` or name what is `missing` and ask about it. When it reports
 * incomplete, the flow must NOT produce a nine-section analysis over guesses —
 * it stops and puts the open questions back to the reporter (see run.ts step 2).
 *
 * Same LLM/variant/data-class inputs `produceAnalysis` uses (the variant reader
 * feeds both — no new env dependency), and the SAME non-ok handling: a queued /
 * degraded / blocked model becomes an `AnalysisHaltedError`. A fail-closed
 * template violation (an incomplete verdict that asks nothing) is a
 * `RoleOutputError` thrown from `runIntake` after its single repair round.
 */
export interface IntakeGateResult {
  /** Whether the ticket is complete enough to analyse. */
  complete: boolean;
  /**
   * The intake verdict with real values re-inserted — what the reporter reads in
   * the clarification comment. On the masked route the display copy re-opens the
   * mask; when nothing was masked it equals the masked copy.
   */
  display: IntakeOutput;
  attempts: number;
}

export interface RequestIntakeArgs {
  llm: LlmPort;
  ticket: TicketSnapshot;
  variantId: string;
  dataClass: DataClass;
  /**
   * The ticket's recent HUMAN comments. `runIntake` reads only the ticket, so
   * the comments are appended to a CLONED snapshot's description (the frozen
   * contract is untouched — this is an object copy). This is what lets the
   * intake see a reporter's İADE answers and judge the ticket complete instead
   * of returning it again forever.
   */
  comments?: readonly TicketComment[];
}

/** Run the real intake role and hand back its verdict for the pilot's gate. */
export async function requestIntake(args: RequestIntakeArgs): Promise<IntakeGateResult> {
  const captured = captureUnmask(args.llm);
  const comments = args.comments ?? [];
  const ticket: TicketSnapshot =
    comments.length === 0
      ? args.ticket
      : { ...args.ticket, description: appendCommentsToDescription(args.ticket.description, comments) };

  const result = await runIntake({
    llm: captured.port,
    ticket,
    variantId: args.variantId,
    dataClass: args.dataClass,
  });

  if (result.status !== "ok") {
    throw new AnalysisHaltedError(
      result.status === "queued"
        ? `model kuyruğa alındı (kota) — ${result.resumeAt}`
        : `model çağrısı '${result.status}': ${result.messageKey}`,
    );
  }

  // The RoleResult value is the MASKED verdict; the display copy re-inserts the
  // real values with the captured unmask (the reporter reads the display copy).
  const display = captured.unmask(result.value);
  return { complete: display.complete, display, attempts: result.attempts };
}
