/**
 * Wire shapes for /auth/*. The BFF declares these locally in apps/bff/src/deps.ts
 * and does NOT export them through packages/contracts, so the Studio restates
 * them here. See RAPOR-iskelet.md "ARAYÜZ İSTEKLERİ" — the durable fix is a
 * shared session contract; until then these two definitions must stay in step.
 */

/** GET /auth/session — flat. */
export interface Session {
  readonly userId: string;
  readonly username: string;
  readonly roles: readonly string[];
  readonly groups: readonly string[];
  /** true when an AI holds the token for a human; gates and kill switch refuse it. */
  readonly delegated: boolean;
  readonly expiresAt: string;
  /**
   * true for the first-run bootstrap admin until it sets a real password
   * (banking standard). While true the app blocks everything but the
   * change-password screen — the BFF restricts the session to match, so a
   * client that ignored this would only meet 409s. Optional on the type so a
   * fixture (and a `/auth/session` payload from a BFF that predates the field)
   * reads as not-restricted; the guard checks `=== true`, the safe default.
   */
  readonly mustChangePassword?: boolean;
}

/** POST /auth/login — nests the user, and adds the token. */
export interface LoginResponse {
  readonly token: string;
  readonly expiresAt: string;
  readonly user: {
    readonly userId: string;
    readonly username: string;
    readonly roles: readonly string[];
    readonly groups: readonly string[];
    /** Forces the change-password screen on first login (banking standard). */
    readonly mustChangePassword?: boolean;
  };
}

/**
 * Login and session return the same data in two different shapes. Normalise on
 * the way in so the rest of the app only ever sees `Session`. Login has no
 * `delegated` field: a human typing a password into Studio is by definition not
 * a delegated agent, so it is false.
 */
export function sessionFromLogin(response: LoginResponse): Session {
  return {
    userId: response.user.userId,
    username: response.user.username,
    roles: response.user.roles,
    groups: response.user.groups,
    delegated: false,
    expiresAt: response.expiresAt,
    mustChangePassword: response.user.mustChangePassword ?? false,
  };
}

/**
 * Roles the BFF actually checks today (apps/bff): `admin` gates the kill switch,
 * `admin`/`tech-lead` gate params and cross-project run visibility. It is a bare
 * string list on the wire with no enum, so this is a convenience union, not a
 * closed set — `hasRole` takes plain strings.
 */
export type KnownRole = "admin" | "tech-lead";

export function hasRole(session: Session | null, role: string): boolean {
  return session?.roles.includes(role) ?? false;
}

export function hasAnyRole(session: Session | null, roles: readonly string[]): boolean {
  if (roles.length === 0) return true;
  return roles.some((role) => hasRole(session, role));
}
