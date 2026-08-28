import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sessionActor } from "../actor.js";
import { authGuard, requireAnyRole, sessionOf } from "../auth/guard.js";
import type { ResolvedDeps } from "../deps.js";
import { badRequest } from "../errors.js";
import { NotifyUpdate, readNotify, updateNotify } from "../notify-service.js";
import { assertWritable } from "../platform/propose.js";
import { readRouting, RoutingUpdate, updateRouting } from "../routing-service.js";
import { putParam } from "../params-service.js";

/**
 * The three administration screens: platform wiring, notification routing and
 * ticket→application routing.
 *
 * All three describe the PLATFORM rather than a piece of work, so they are the
 * admin surface (M86) — a developer does not need to know which Vault path the
 * Jira credential lives at — and all three are read by `admin` and `tech-lead`
 * but written by `admin` alone.
 *
 * Every write goes through the M71 parameter path rather than touching a store
 * directly. That is what makes a guarded setting take four eyes (M32/M78) no
 * matter which screen edited it: a second write path around `putParam` would
 * mean the guard depends on the caller, which is not a guard.
 */
export const SETTINGS_READ_ROLES = ["admin", "tech-lead"] as const;
export const SETTINGS_WRITE_ROLES = ["admin"] as const;

/**
 * `PUT /settings` edits operational parameters by key.
 *
 * Deliberately NOT a whole-document PUT of the settings view. The connections
 * that view shows are read out of the environment and the probes — an endpoint
 * and a credential reference are deployment facts, not rows a console may
 * rewrite — so accepting them back would let a screen appear to change
 * something it cannot. What IS editable is the parameter set, and each entry
 * names its key.
 */
const SettingsUpdate = z.object({
  changes: z
    .array(
      z.object({
        key: z.string().min(1).max(64),
        /** `null` = global scope; a project key or app id otherwise. */
        scopeRef: z.string().min(1).max(64).nullable().default(null),
        value: z.unknown(),
      }),
    )
    .min(1)
    .max(50),
});

export async function settingsRoutes(app: FastifyInstance, deps: ResolvedDeps): Promise<void> {
  const readHandler = [authGuard(deps), requireAnyRole(...SETTINGS_READ_ROLES)];
  const writeHandler = [authGuard(deps), requireAnyRole(...SETTINGS_WRITE_ROLES)];

  /**
   * Platform wiring. `credentialRef` is a Vault path or an auth method and
   * never the secret: a console that can display a PAT is a console that can
   * leak it into a screenshot, so the value never leaves the process.
   */
  app.get("/settings", { preHandler: readHandler }, async (_request, reply) => {
    const [connections, notifyDrivers] = await Promise.all([
      deps.settings.connections(),
      deps.settings.notifyDrivers(),
    ]);
    return reply.code(200).send({ connections, notifyDrivers });
  });

  app.put("/settings", { preHandler: writeHandler }, async (request, reply) => {
    await assertWritable(deps);
    const body = SettingsUpdate.safeParse(request.body);
    if (!body.success) throw badRequest("invalid_settings_body");

    const session = sessionOf(request);
    const actor = sessionActor(session);
    // Sequential rather than `Promise.all`: each `putParam` reads the current
    // version to compute the next one, and two of them racing on the same key
    // would both write version n+1.
    const results = [];
    for (const change of body.data.changes) {
      results.push(
        await putParam(deps, {
          key: change.key,
          scopeRef: change.scopeRef,
          value: change.value,
          actor,
          // Groups let a master admin self-approve a guarded change; other
          // roles still need a second person (master-approver.ts).
          actorGroups: session.groups,
        }),
      );
    }

    // A guarded key comes back `pending`, not `applied` — the screen has to be
    // able to tell "saved" from "waiting for a second pair of eyes", and a bare
    // 204 would make the two indistinguishable.
    return reply.code(200).send({ results });
  });

  /** The reminder ladder and channel routing (M45/M71/M88). */
  app.get("/notify", { preHandler: readHandler }, async (_request, reply) => {
    return reply.code(200).send(await readNotify(deps));
  });

  app.put("/notify", { preHandler: writeHandler }, async (request, reply) => {
    await assertWritable(deps);
    const body = NotifyUpdate.safeParse(request.body);
    if (!body.success) {
      throw badRequest("invalid_notify_body", {
        issues: body.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
      });
    }

    const results = await updateNotify(deps, body.data, sessionActor(sessionOf(request)));
    return reply.code(200).send({ results });
  });

  /** Ticket→application routing (M99/M102). */
  app.get("/routing", { preHandler: readHandler }, async (_request, reply) => {
    return reply.code(200).send(await readRouting(deps));
  });

  app.put("/routing", { preHandler: writeHandler }, async (request, reply) => {
    await assertWritable(deps);
    const body = RoutingUpdate.safeParse(request.body);
    if (!body.success) {
      throw badRequest("invalid_routing_body", {
        issues: body.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
      });
    }

    const result = await updateRouting(deps, body.data, sessionActor(sessionOf(request)));
    return reply.code(200).send(result);
  });
}
