import { createSession, defaultPiiPolicy, maskText, type MaskSession } from "@maestro/pii";

/**
 * Output masking for the log stream (task #6).
 *
 * TWO layers, because they defend against different things:
 *
 *  ① **Literal secrets this agent knows.** The shared token, and any value the
 *    agent injected into the job's environment. `@maestro/pii` cannot help
 *    here: a random token matches no detector. This layer is exact-substring
 *    redaction, and it is the one that closes the finding where a password was
 *    recoverable from an error message.
 *
 *  ② **PII the job printed.** A build log that echoes a customer record is a
 *    data leak even though no credential is involved; the `@maestro/pii`
 *    boundary is the institution's policy for that, so it is reused rather
 *    than re-implemented.
 *
 * Order matters: ① runs FIRST. A token that happened to look like an account
 * number would otherwise be tokenised into a reversible `[ACCOUNT_1]` — the
 * reverse map is exactly what must never hold a credential.
 */

export const REDACTED = "[REDACTED]";

/**
 * Secrets shorter than this are not redacted as literals. A 3-character
 * "secret" appears inside ordinary words, and redacting it would shred the log
 * into `[REDACTED]` noise while protecting something that was never secret.
 * Real credentials are far longer; `AgentToken` itself demands 24+.
 */
export const MIN_REDACTABLE_LENGTH = 8;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A masker bound to one set of literal secrets. Built once per job so the
 * secret list is scoped to that job's environment, and so the PII session's
 * token numbering is per-job rather than global.
 */
export interface OutputMasker {
  /** Masks one chunk of job output. Never throws: a masking failure must not lose the log. */
  mask(text: string): string;
}

/**
 * Builds the literal-redaction pattern. Longest secrets first, so that a
 * secret which CONTAINS another is redacted whole rather than leaving its
 * tail behind as a fragment.
 */
function literalPattern(secrets: readonly string[]): RegExp | undefined {
  const usable = [...new Set(secrets)]
    .filter((secret) => secret.trim().length >= MIN_REDACTABLE_LENGTH)
    .sort((a, b) => b.length - a.length);
  if (usable.length === 0) return undefined;
  return new RegExp(usable.map(escapeRegExp).join("|"), "g");
}

export interface OutputMaskerOptions {
  /** Literal values that must never appear in output: the token, job env values. */
  secrets: readonly string[];
  /**
   * PII masking session. Omitted means "build the institution default for the
   * strictest class" — the safe direction when the caller did not decide.
   */
  session?: MaskSession;
}

export function createOutputMasker(options: OutputMaskerOptions): OutputMasker {
  const pattern = literalPattern(options.secrets);
  const session = options.session ?? createSession(defaultPiiPolicy().profiles.gizli);

  return {
    mask(text: string): string {
      if (text.length === 0) return text;
      // ① literal secrets — exact, unconditional, before anything can tokenise them.
      const redacted = pattern === undefined ? text : text.replace(pattern, REDACTED);
      // ② institutional PII policy.
      try {
        return maskText(redacted, session).text;
      } catch {
        // The PII layer failing must not surface the ① output un-streamed, but
        // it must also never surface material that layer ② would have masked.
        // Dropping the chunk is the fail-closed choice.
        return REDACTED;
      }
    },
  };
}

/**
 * The literal secrets of one job: the agent's own token plus every value the
 * job carries in its environment. `RunJob.env` holds short-lived credentials
 * (M80), and those are precisely what a stack trace tends to print.
 */
export function jobSecrets(token: string, env: Readonly<Record<string, string>>): string[] {
  return [token, ...Object.values(env)];
}
