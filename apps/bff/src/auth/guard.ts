import type { FastifyRequest, preHandlerHookHandler } from "fastify";
import type { ResolvedDeps, SessionRecord } from "../deps.js";
import { conflict, forbidden, unauthenticated } from "../errors.js";
import { bearerToken, isExpired } from "./sessions.js";

/** Options for {@link authGuard}. */
export interface AuthGuardOptions {
  /**
   * Let a RESTRICTED (first-run bootstrap) session through. Off by default, so
   * a route that forgets to opt in fails CLOSED — a bootstrap admin holding
   * `admin`/`admin123` reaches nothing. Only the three routes a restricted
   * session is meant to reach set it: change-password, logout, session.
   */
  allowRestricted?: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set by {@link authGuard}; absent means the route was never guarded. */
    maestroSession?: SessionRecord;
  }
}

/**
 * Bearer-token authentication for every REST route (M7: no unauthenticated
 * data path exists — v1's second, auth-free CRUD surface is what this closes).
 * The webhook routes are not exempt: they authenticate with the delivery
 * signature instead, through the port.
 *
 * The session is a CACHE; the directory is the truth. Roles and group
 * membership are re-read on every request and the account's state is checked,
 * because an eight-hour token issued before an off-boarding would otherwise
 * carry the departed employee's authority for the rest of those eight hours
 * (M8/M32). Deactivating an account or revoking a role has to take effect at
 * the next request, not at the next login.
 */
export function authGuard(
  deps: ResolvedDeps,
  options: AuthGuardOptions = {},
): preHandlerHookHandler {
  return async (request) => {
    const token = bearerToken(request.headers.authorization);
    if (token === null) throw unauthenticated();

    const session = await deps.sessions.get(token);
    if (session === null) throw unauthenticated();

    if (isExpired(session, deps.clock.now())) {
      await deps.sessions.delete(session.token);
      throw unauthenticated("session_expired");
    }

    // Deleted and deactivated accounts are the same answer here: the token is
    // no longer usable, and every OTHER session of theirs dies with it — an
    // off-boarding that only closed the tab in front of you is not one.
    const user = await deps.users.find(session.username);
    if (user === null || !user.active) {
      await deps.sessions.deleteByUser(session.userId);
      throw unauthenticated();
    }

    // The bootstrap flag is refreshed from the directory here, exactly like
    // roles and groups: the session store is a cache and the directory is the
    // truth, so a change-password that clears the flag takes effect on the NEXT
    // request rather than the next login.
    const mustChangePassword = user.mustChangePassword ?? false;

    request.maestroSession = {
      ...session,
      roles: [...user.roles],
      groups: [...user.groups],
      mustChangePassword,
    };

    // A restricted (first-run bootstrap) session may reach ONLY the routes that
    // opt in: change-password, logout, session. Everything else — every admin
    // surface, the kill switch, run signals — is refused with a named 409 until
    // the account sets a policy-compliant password. Refused AFTER the session is
    // attached so a handler that logs the actor still can (M33), and as 409
    // `password_change_required` rather than 403 so Studio can tell "you must
    // change your password" apart from "you lack a role".
    if (mustChangePassword && options.allowRestricted !== true) {
      throw conflict("password_change_required");
    }
  };
}

/** Roles gate the admin surface (M86: Studio is open, but not every screen is). */
export function requireRole(role: string): preHandlerHookHandler {
  return async (request) => {
    const session = sessionOf(request);
    if (!session.roles.includes(role)) throw forbidden("role_required", { role });
  };
}

/**
 * Any one of these roles will do (M86: settings screens are admin AND tech
 * lead, not admin alone). The refusal names the accepted set rather than the
 * caller's roles — an error body tells Studio what to hide, never what the
 * caller is missing on the way to enumerating privileges.
 */
export function requireAnyRole(...roles: readonly string[]): preHandlerHookHandler {
  return async (request) => {
    const session = sessionOf(request);
    if (!roles.some((role) => session.roles.includes(role))) {
      throw forbidden("role_required", { anyOf: roles });
    }
  };
}

/**
 * The session a guarded handler runs under. Throwing rather than returning
 * `undefined` keeps a route that forgot its guard from reading as anonymous.
 */
export function sessionOf(request: FastifyRequest): SessionRecord {
  const session = request.maestroSession;
  if (session === undefined) throw unauthenticated();
  return session;
}
