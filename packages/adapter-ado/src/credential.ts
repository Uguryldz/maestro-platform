import { IsoDateTime } from "@maestro/contracts";
import type { RepoRef } from "@maestro/ports";
import { AdoResponseError } from "./errors.js";

/**
 * Issues a short-lived credential. Injected as a callback so this package
 * never imports the secrets package (M44 clean-room DI / M80); the
 * composition root passes `SecretPort.issueShortLived`.
 */
export type SecretIssuer = (
  scope: string,
  ttlSeconds: number,
) => Promise<{ secret: string; expiresAt: string }>;

/**
 * Slack allowed between the requested TTL and the credential's own expiry:
 * the issuer and this process do not share a clock to the millisecond.
 */
export const EXPIRY_SKEW_SECONDS = 60;

/** Secret scope key for a repository push credential (stable, greppable). */
export function pushScope(repo: RepoRef): string {
  return `ado/${repo.project}/${repo.repo}/push`;
}

/**
 * Requested TTL check (M31). "Short-lived" is a property of the request as
 * much as of the credential: a ten-year TTL is refused before the issuer is
 * ever called, so no long-lived push token is minted in the first place.
 */
export function assertTtlWithinCeiling(ttlSeconds: number, maxPushTtlSeconds: number): void {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new AdoResponseError("getPushCredential", [`invalid ttlSeconds: ${ttlSeconds}`]);
  }
  if (ttlSeconds > maxPushTtlSeconds) {
    throw new AdoResponseError("getPushCredential", [
      `ttlSeconds ${ttlSeconds} exceeds the ${maxPushTtlSeconds}s ceiling (M31)`,
    ]);
  }
}

/**
 * Issued-credential check: the value must exist, its expiry must be a real
 * ISO timestamp, it must still be alive now, and it must die inside the
 * window it was asked for. Anything else is a failure, not a warning — an
 * unbounded push token is exactly the credential M31 exists to prevent.
 */
export function issuedCredentialIssues(
  issued: { secret: string; expiresAt: string } | undefined,
  ttlSeconds: number,
  nowMs: number,
): string[] {
  const issues: string[] = [];
  if (typeof issued?.secret !== "string" || issued.secret.length === 0) {
    issues.push("issuer returned an empty secret");
  }
  if (!IsoDateTime.safeParse(issued?.expiresAt).success) {
    issues.push(`issuer returned a non-ISO expiresAt: ${String(issued?.expiresAt)}`);
    return issues;
  }
  const expiry = Date.parse(issued!.expiresAt);
  if (expiry <= nowMs) {
    issues.push(`issuer returned an already-expired credential: ${issued!.expiresAt}`);
  } else if (expiry - nowMs > (ttlSeconds + EXPIRY_SKEW_SECONDS) * 1000) {
    issues.push(`issued credential outlives its ${ttlSeconds}s ttl (expires ${issued!.expiresAt})`);
  }
  return issues;
}
