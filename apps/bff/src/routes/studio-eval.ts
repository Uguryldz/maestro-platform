import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sessionActor } from "../actor.js";
import { authGuard, requireAnyRole, sessionOf } from "../auth/guard.js";
import type { ResolvedDeps } from "../deps.js";
import { assertWritable } from "../platform/propose.js";
import { readEval, recordEvalDecision } from "../eval-service.js";

/**
 * Golden-ticket evaluation (M38/M43/M78).
 *
 * `GET /eval` reads the reference pool and the most recent eval run so a
 * regression is visible BEFORE a variant version ships. It refuses by name (503)
 * when no eval store is wired rather than answer an empty pool — an empty page
 * renders as "no regressions" on a platform that has measured none, and that is
 * the one sentence this screen must never say by accident (`routes/unwired.ts`).
 *
 * `POST /eval/decisions` records the M78 gate outcome. Any session may READ the
 * eval surface — an engineer must see how their variant scored — but DECIDING to
 * ship or block is `admin`, and shipping a regression needs a written
 * justification the service enforces and the audit trail keeps.
 */

/** The wire shape of `GET /eval`, validated on the way OUT. */
const EvalOut = z.object({
  goldenTickets: z.array(
    z.object({
      goldenId: z.string().min(1),
      sourceTicket: z.string().min(1),
      kind: z.string().min(1),
      expectation: z.string(),
      lastScore: z.number().nullable(),
    }),
  ),
  lastRun: z
    .object({
      runId: z.string().min(1),
      variantId: z.string().min(1),
      baselineVersion: z.number().int().nonnegative(),
      candidateVersion: z.number().int().nonnegative(),
      at: z.string().min(1),
      results: z.array(
        z.object({
          goldenId: z.string().min(1),
          baselineScore: z.number().nullable(),
          candidateScore: z.number().nullable(),
        }),
      ),
      decision: z.object({
        status: z.enum(["pending", "shipped", "blocked"]),
        justification: z.string(),
        decidedBy: z.string().nullable(),
        decidedAt: z.string().nullable(),
      }),
    })
    .nullable(),
});

export async function studioEvalRoutes(app: FastifyInstance, deps: ResolvedDeps): Promise<void> {
  const preHandler = authGuard(deps);
  const writeHandler = [preHandler, requireAnyRole("admin")];

  app.get("/eval", { preHandler }, async (_request, reply) => {
    const view = await readEval(deps);
    return reply.code(200).send(EvalOut.parse(view));
  });

  app.post("/eval/decisions", { preHandler: writeHandler }, async (request, reply) => {
    // The kill switch stops writes (M58), checked before the body is looked at.
    await assertWritable(deps);
    const run = await recordEvalDecision(deps, {
      body: request.body,
      actor: sessionActor(sessionOf(request)),
    });
    return reply.code(200).send(run);
  });
}
