import { createHash } from "node:crypto";
import type { PublishRequest } from "@maestro/contracts";
import {
  assertNoPii,
  compiledProfileFor,
  createSessionWith,
  maskText,
  type DataClassName,
  type LoadedPiiPolicy,
  type MaskCounts,
} from "@maestro/pii";
import { PublishRenderError } from "./errors.js";
import type { PublishRedactor } from "./port.js";
import type { RunContextResolver } from "./types.js";

/**
 * PII gate of the publish path (M20/M82).
 *
 * Everything this port publishes is an ARTEFACT: a Confluence page, a Jira
 * comment and — worst of the three — a commit in the application's own git
 * history, where a raw TCKN or IBAN is effectively unerasable. The analysis
 * body is model output over ticket text, so it carries whatever the reporter
 * pasted. Masking therefore happens once, at the port, before the fan-out:
 * every target then receives the same masked bytes and no driver can be added
 * later that forgets to ask.
 *
 * The ReverseMap is created and dropped inside `redact` — re-identification
 * belongs to a live screen (M20), never to a ten-year artefact.
 */
export interface PublishPiiDeps {
  /** A policy that went through `loadPiiPolicy` — a literal will not compile. */
  readonly policy: LoadedPiiPolicy;
  /** Audit hook (M33 `PII_MASKED`). Receives counts — never values. */
  readonly onMasked?: (counts: MaskCounts, dataClass: DataClassName, req: PublishRequest) => void;
}

export const PUBLISH_PII_BOUNDARY = "publish";

/**
 * The masking session's nonce is derived from the run id instead of being
 * random. Tokens are part of the published bytes, and every driver's
 * idempotency check compares bytes: a random nonce would make the same
 * document hash differently on every republish and would open a second Jira
 * comment, burn a Confluence version and add an empty commit each time.
 * The nonce is documented as non-secret and value-free, so deriving it costs
 * nothing.
 */
function sessionNonce(runId: string): string {
  return createHash("sha256").update(`publish:${runId}`, "utf8").digest("hex").slice(0, 8);
}

/**
 * Values that must survive masking, e.g. the corporate address of the person
 * who signed a gate: the evidence summary exists to say WHO approved, and
 * `[EMAIL_1.9f3c]` would destroy exactly the fact it is kept for (M82).
 *
 * They are swapped for a placeholder before masking and put back afterwards,
 * so the exemption never widens: the tripwire still runs over a text in which
 * every non-exempt identifier is a token, and an approver address that also
 * happens to appear in a customer complaint is exempt only because the
 * composition root listed it.
 */
function placeholderFor(index: number): string {
  return `maestro-allow-${String(index)}-x`;
}

function applyAllowList(text: string, allowed: readonly string[]): { text: string; used: string[] } {
  const used: string[] = [];
  let out = text;
  // Longest first: a shorter allowed value must not eat a longer one's prefix.
  for (const value of [...new Set(allowed)].sort((a, b) => b.length - a.length)) {
    if (value.trim().length === 0 || !out.includes(value)) continue;
    out = out.split(value).join(placeholderFor(used.length));
    used.push(value);
  }
  return { text: out, used };
}

function restoreAllowList(text: string, used: readonly string[]): string {
  let out = text;
  used.forEach((value, index) => {
    out = out.split(placeholderFor(index)).join(value);
  });
  return out;
}

/**
 * Build the port's redactor. `runContext` supplies the run's declared data
 * class (absent/unrecognised → strictest profile, M18/M63) and the identities
 * the institution requires to stay readable.
 */
export function createPublishRedactor(pii: PublishPiiDeps, runContext: RunContextResolver): PublishRedactor {
  return async (req: PublishRequest, markdownSource: string): Promise<string> => {
    const context = await runContext(req.runId);
    const { profile, dataClass } = compiledProfileFor(pii.policy, context.dataClass);
    const { text, used } = applyAllowList(markdownSource, context.piiExemptions ?? []);

    const session = createSessionWith(profile, sessionNonce(req.runId));
    const masked = maskText(text, session);
    pii.onMasked?.(masked.counts, dataClass, req);
    // Fail-closed: a detector the masker did not apply must stop the publish
    // rather than reach three egresses at once.
    assertNoPii(masked.text, profile, `${PUBLISH_PII_BOUNDARY}:${req.doc}`);

    const out = restoreAllowList(masked.text, used);
    assertTemplatePinSurvived(markdownSource, out);
    return out;
  };
}

const TEMPLATE_PIN = /<!--\s*maestro:doc[^>]*\btemplate=(\S+?)\s/;

/**
 * The M83 pin says which standard the document was written against, and an
 * audit reads it off the page. A version like `analysis-template@1.4.0` is an
 * email as far as the detectors are concerned, so leaving it off the exemption
 * list would replace the pin with a token — silently, in every target at once.
 * Loud beats silent: the run stops and the composition root gets told what to
 * add.
 */
function assertTemplatePinSurvived(source: string, masked: string): void {
  const pin = TEMPLATE_PIN.exec(source)?.[1];
  if (pin === undefined || masked.includes(pin)) return;
  throw new PublishRenderError(
    `the M83 template pin "${pin}" was masked away — list it in runContext(...).piiExemptions`,
  );
}
