import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isHumanChannel, sessionActor } from "../actor.js";
import { authGuard, requireRole, sessionOf } from "../auth/guard.js";
import type { ResolvedDeps } from "../deps.js";
import { badRequest, forbidden } from "../errors.js";
import { operateKillSwitch } from "../killswitch-service.js";

/** The role that may operate the switch; groups come from the directory (M8). */
export const KILL_SWITCH_ROLE = "admin";

const KillSwitchBody = z.object({
  level: z.enum(["off", "intake_only", "all"]),
  reason: z.string().trim().min(1),
});

/**
 * Two-level kill switch (M58). Admin-only, audited, and human-only: M101 gives
 * maestro-mcp an admin-suggestion scope, never the switch itself, so a
 * delegated token is refused here rather than trusted because it was minted
 * from an admin's account.
 */
export async function killSwitchRoutes(app: FastifyInstance, deps: ResolvedDeps): Promise<void> {
  app.post(
    "/killswitch",
    { preHandler: [authGuard(deps), requireRole(KILL_SWITCH_ROLE)] },
    async (request, reply) => {
      const session = sessionOf(request);
      if (!isHumanChannel(session)) throw forbidden("human_channel_only");

      const body = KillSwitchBody.safeParse(request.body);
      if (!body.success) throw badRequest("invalid_killswitch_body");

      const result = await operateKillSwitch(deps, {
        level: body.data.level,
        reason: body.data.reason,
        actor: sessionActor(session),
      });
      return reply.code(200).send(result);
    },
  );

  app.get("/killswitch", { preHandler: authGuard(deps) }, async (_request, reply) => {
    return reply.code(200).send(await deps.killSwitch.get());
  });
}
