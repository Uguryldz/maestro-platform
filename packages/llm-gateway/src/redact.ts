import { compileProfile, createSessionWith, defaultPiiPolicy, maskText, resolveProfile, type CompiledProfile } from "@maestro/pii";

/**
 * Nothing that leaves this package may carry a credential or a customer's
 * identifiers (M19/M82). Provider error bodies are the sneaky case: a 400 from
 * a gateway happily echoes the request — key header and all — and a structured
 * logger then writes the whole error object to disk.
 */

/** Credential shapes, matched without capture groups so one pass replaces all. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g, // Anthropic / OpenAI style keys
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bya29\.[A-Za-z0-9._-]{10,}/g, // Google OAuth access token
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, // JWT
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
];

/** `"apiKey": "…"` style fields, whose value is a secret whatever it looks like. */
const KEYED_SECRET = /("(?:api[_-]?key|authorization|auth|password|passwd|secret|token|credential)"\s*:\s*")[^"]*"/gi;

export const REDACTED = "[REDACTED]";

let strictProfile: CompiledProfile | undefined;

/** The strictest built-in profile: every detector, so nothing is let through. */
function profile(): CompiledProfile {
  strictProfile ??= compileProfile(resolveProfile(defaultPiiPolicy(), "gizli").profile);
  return strictProfile;
}

/**
 * Strip credentials and PII from free text before an error object carries it.
 * The masking session is created and dropped here on purpose — an error body is
 * never un-masked, so no ReverseMap may survive this call (M20).
 */
export function redact(text: string): string {
  if (text.length === 0) return text;
  let out = text.replace(KEYED_SECRET, `$1${REDACTED}"`);
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  return maskText(out, createSessionWith(profile())).text;
}
