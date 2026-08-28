import { createHash, timingSafeEqual } from "node:crypto";
import { AdoConfigError, AdoWebhookAuthError } from "./errors.js";

/**
 * Shared secret configured on BOTH sides: the ADO Service Hook subscription
 * ("Basic authentication username/password" on the consumer) and Maestro's
 * webhook endpoint.
 *
 * Azure DevOps Service Hooks do not sign their payloads — there is no HMAC
 * header to verify, unlike Jira. Basic auth over TLS plus a source-IP
 * allowlist is the whole authentication story, which is exactly why this
 * check is fail-closed and why the secret must be long and random.
 */
export interface ServiceHookAuth {
  /** Username half of the credential; ADO allows it to be empty. */
  username?: string;
  password: string;
}

export type ServiceHookAuthResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "malformed" | "mismatch" };

/**
 * Verifies the `Authorization` header of an incoming Service Hook request.
 * Every failure mode returns ok:false — a missing header is never treated
 * as "no auth configured, let it through".
 */
export function verifyServiceHookAuth(
  authorizationHeader: string | undefined | null,
  expected: ServiceHookAuth,
): ServiceHookAuthResult {
  if (typeof expected.password !== "string" || expected.password.length === 0) {
    // Refusing to start is better than accepting anything (M6 fail-closed).
    throw new AdoConfigError(["service hook shared secret is empty"]);
  }
  if (typeof authorizationHeader !== "string" || authorizationHeader.trim() === "") {
    return { ok: false, reason: "missing" };
  }

  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(authorizationHeader.trim());
  const encoded = match?.[1];
  if (encoded === undefined) return { ok: false, reason: "malformed" };

  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!decoded.includes(":")) return { ok: false, reason: "malformed" };

  const want = `${expected.username ?? ""}:${expected.password}`;
  return constantTimeEquals(decoded, want) ? { ok: true } : { ok: false, reason: "mismatch" };
}

/** Throwing form for webhook handlers. */
export function assertServiceHookAuth(
  authorizationHeader: string | undefined | null,
  expected: ServiceHookAuth,
): void {
  const result = verifyServiceHookAuth(authorizationHeader, expected);
  if (!result.ok) throw new AdoWebhookAuthError(result.reason);
}

/** Compares digests so neither the length nor a prefix leaks through timing. */
function constantTimeEquals(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}
