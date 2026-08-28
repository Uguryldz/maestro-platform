/**
 * Errors of the thinking-role layer.
 *
 * Two of them are deliberate dead ends: a template that cannot enforce
 * traceability and an output that stays deficient after its repair round.
 * Neither may be turned into a "best effort" result — M43 is fail-closed, so a
 * document that does not validate must never reach a human gate.
 */

/** The template itself is unusable (M108 designer produced an invalid shape). */
export class TemplateError extends Error {
  constructor(
    readonly templateId: string,
    message: string,
  ) {
    super(`template "${templateId}": ${message}`);
    this.name = "TemplateError";
  }
}

/**
 * Role output failed validation after the single repair round (M43).
 * `deficiencies` are the Turkish, concrete items that were handed back to the
 * model — the same list a human sees in the journal.
 */
export class RoleOutputError extends Error {
  constructor(
    readonly role: string,
    readonly attempts: number,
    readonly deficiencies: readonly string[],
  ) {
    super(
      `role "${role}" output invalid after ${attempts} attempt(s):\n- ${deficiencies.join("\n- ")}`,
    );
    this.name = "RoleOutputError";
  }
}

/** A prompt text was requested that the prompt data file does not carry. */
export class MissingPromptError extends Error {
  constructor(readonly key: string) {
    super(`missing prompt text "${key}"`);
    this.name = "MissingPromptError";
  }
}
