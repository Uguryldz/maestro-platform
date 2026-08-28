import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authGuard, sessionOf } from "../auth/guard.js";
import { issueSession, MAX_SESSIONS_PER_USER } from "../auth/sessions.js";
import { passwordChangerOf, type ResolvedDeps } from "../deps.js";
import { badRequest, unauthenticated, unavailable } from "../errors.js";

const LoginBody = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
});

const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(1),
});

/**
 * Session issuance (M8). The token is a bearer credential with an absolute
 * eight-hour life; it does not slide, and nothing here reveals whether a
 * failed login was a wrong password or an unknown account.
 */
export async function authRoutes(app: FastifyInstance, deps: ResolvedDeps): Promise<void> {
  app.post("/auth/login", async (request, reply) => {
    const body = LoginBody.safeParse(request.body);
    if (!body.success) throw badRequest("invalid_login_body");

    const user = await deps.identity.authenticate(body.data.username, body.data.password);
    if (user === null) throw unauthenticated("invalid_credentials");

    const session = issueSession(user, { clock: deps.clock, ttlMs: deps.config.sessionTtlMs });
    await evictOldestSessions(deps, user.userId);
    await deps.sessions.create(session);

    return reply.code(200).send({
      token: session.token,
      expiresAt: session.expiresAt,
      user: {
        userId: session.userId,
        username: session.username,
        roles: session.roles,
        groups: session.groups,
        // So the client redirects the bootstrap admin straight to the
        // change-password screen and blocks the rest of the app (migration
        // 0009). False for every normal login.
        mustChangePassword: user.mustChangePassword ?? false,
      },
    });
  });

  /**
   * Change the caller's own password (M8 self-service; the first-run bootstrap
   * admin is forced through here on first login, migration 0009).
   *
   * `allowRestricted` so a restricted bootstrap session — which reaches nothing
   * else — can still reach this, the one route that lets it escape the
   * restriction. The provider verifies the CURRENT password and runs the FULL
   * policy on the NEW one (so `admin123` cannot be re-set — it is too short and
   * has no symbol), re-keys, and clears `mustChangePassword`. A successful
   * change then kills EVERY session of the account, this one included: the
   * client re-authenticates with the new password, and any other live token
   * (including a stolen one) dies with it.
   */
  app.post(
    "/auth/change-password",
    { preHandler: authGuard(deps, { allowRestricted: true }) },
    async (request, reply) => {
      const changer = passwordChangerOf(deps.identity);
      // An AD/LDAP-backed login owns no password this platform may rewrite:
      // refuse rather than pretend (same discipline as the admin add-user path).
      if (changer === null) throw unavailable("password_change_unavailable");

      const body = ChangePasswordBody.safeParse(request.body);
      if (!body.success) throw badRequest("invalid_change_password_body");

      const session = sessionOf(request);
      const rekeyed = await changer.changePassword(
        session.username,
        body.data.currentPassword,
        body.data.newPassword,
      );
      // `null` is the wrong current password (or a vanished account). Never say
      // which — the policy failure, by contrast, throws `password_policy` with
      // its violations from inside the provider before reaching here.
      if (rekeyed === null) throw unauthenticated("invalid_credentials");

      // Kill every session of this account, including the one that made the
      // request: the old password is gone, so every token minted under it must
      // go too. The client logs back in with the new password.
      await deps.sessions.deleteByUser(session.userId);

      return reply.code(204).send();
    },
  );

  /**
   * Logging out ends the ACCOUNT's sessions, not just this tab's. Someone who
   * logs out because "something looked wrong" means all of it, and a stolen
   * token will never log itself out (M8).
   */
  // `allowRestricted`: a bootstrap admin who cannot yet do anything must still
  // be able to log out.
  app.post(
    "/auth/logout",
    { preHandler: authGuard(deps, { allowRestricted: true }) },
    async (request, reply) => {
      await deps.sessions.deleteByUser(sessionOf(request).userId);
      return reply.code(204).send();
    },
  );

  // `allowRestricted`: the client probes the session on boot to learn whether it
  // must redirect to the change-password screen, so a restricted session has to
  // be able to read its own state — that is how it learns it is restricted.
  app.get(
    "/auth/session",
    { preHandler: authGuard(deps, { allowRestricted: true }) },
    async (request, reply) => {
      const session = sessionOf(request);
      return reply.code(200).send({
        userId: session.userId,
        username: session.username,
        roles: session.roles,
        groups: session.groups,
        delegated: session.delegated,
        expiresAt: session.expiresAt,
        // The client blocks the app and shows the change-password screen while
        // this is true (migration 0009).
        mustChangePassword: session.mustChangePassword ?? false,
      });
    },
  );
}

/**
 * Make room for the session about to be issued. Evicting the OLDEST rather
 * than refusing the newest keeps the cap from becoming a lockout: a user whose
 * quota is full of forgotten tokens can always still log in.
 */
async function evictOldestSessions(deps: ResolvedDeps, userId: string): Promise<void> {
  const live = await deps.sessions.listByUser(userId);
  const excess = live.length - (MAX_SESSIONS_PER_USER - 1);
  if (excess <= 0) return;

  const oldestFirst = [...live].sort((a, b) => Date.parse(a.issuedAt) - Date.parse(b.issuedAt));
  for (const stale of oldestFirst.slice(0, excess)) {
    await deps.sessions.delete(stale.token);
  }
}
