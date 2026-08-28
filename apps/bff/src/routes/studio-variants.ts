import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sessionActor } from "../actor.js";
import { authGuard, requireAnyRole, sessionOf } from "../auth/guard.js";
import type { ResolvedDeps } from "../deps.js";
import { badRequest, notFound } from "../errors.js";
import { assertWritable } from "../platform/propose.js";
import {
  VariantId,
  createVariant,
  editVariant,
  publishVariantVersion,
} from "../variant-service.js";
import { unwired } from "./unwired.js";

/**
 * The variant catalogue (M38), and the cache/workspace screen (M4/M65).
 *
 * The two live together because they are the pair that shows the rule this
 * project keeps re-deriving. `/variants` reads tables that exist AND that
 * something writes, so it answers for real. `/cache` reads a screen contract
 * whose facts — the runner holding a workspace, its size on disk, its session
 * state — have no producer anywhere in this platform, so it REFUSES by name.
 * Same file, opposite verdicts, and the difference is only ever "does anything
 * write this".
 */

/** Wire shape of `GET /variants`. Validated on the way OUT, not just in. */
const VariantSummaryOut = z.object({
  variantId: z.string().min(1),
  role: z.string().min(1),
  platform: z.string().min(1),
  model: z.string().min(1),
  activeVersion: z.number().int().nonnegative(),
  knowledgeFiles: z.number().int().nonnegative(),
  evalScore: z.number().nullable(),
});

const VariantDetailOut = z.object({
  variantId: z.string().min(1),
  role: z.string().min(1),
  platform: z.string().min(1),
  model: z.string().min(1),
  activeVersion: z.number().int().nonnegative(),
  persona: z.string(),
  knowledge: z.array(
    z.object({
      docId: z.string().min(1),
      fileName: z.string().min(1),
      category: z.string().min(1),
      version: z.number().int().nonnegative(),
    }),
  ),
  versions: z.array(
    z.object({
      version: z.number().int().nonnegative(),
      publishedAt: z.string().min(1),
      publishedBy: z.string().min(1),
      note: z.string(),
      evalScore: z.number().nullable(),
    }),
  ),
});

/** The variant id grammar — the same `VarChar(64)` the table stores. */
const VariantIdParam = z.object({
  variantId: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "variant ids are lower-case, dash-separated"),
});

export async function studioVariantRoutes(app: FastifyInstance, deps: ResolvedDeps): Promise<void> {
  const preHandler = authGuard(deps);

  /**
   * The variant catalogue (M38). Any session may read it: a variant is a
   * prompt-and-knowledge overlay, it carries no customer data, and an engineer
   * has to be able to see which persona is answering on their ticket.
   */
  app.get("/variants", { preHandler }, async (_request, reply) => {
    const catalog = deps.studio.variants;
    if (catalog === undefined) unwired("variants");

    const rows = await catalog.list();
    const variants = z.array(VariantSummaryOut).parse(rows);
    return reply.code(200).send({ variants });
  });

  app.get("/variants/:variantId", { preHandler }, async (request, reply) => {
    const catalog = deps.studio.variants;
    if (catalog === undefined) unwired("variants");

    const parsed = VariantIdParam.safeParse(request.params);
    if (!parsed.success) throw badRequest("invalid_variant_id");

    const detail = await catalog.get(parsed.data.variantId);
    // 404 rather than an empty detail: a variant that does not exist and a
    // variant with no versions are different answers, and only one of them
    // means the operator typed the wrong id.
    if (detail === null) throw notFound("unknown_variant");

    return reply.code(200).send(VariantDetailOut.parse(detail));
  });

  /**
   * Writing a variant is `admin` alone (M86). Reading the catalogue is open —
   * an engineer must see which persona answers on their ticket — but the persona
   * and the model an agent runs under decide what the AI does on every ticket in
   * the institution, and changing them is not a per-project decision.
   *
   * Every write is guarded THREE ways: the role above, the kill switch (M58, no
   * writes while the platform is stopped), and the version sequence the store
   * owns (M83, append-only). The author and timestamp are derived from the
   * session and the clock in the service — never taken from the body.
   */
  const writeHandler = [preHandler, requireAnyRole("admin")];

  app.post("/variants", { preHandler: writeHandler }, async (request, reply) => {
    await assertWritable(deps);
    const detail = await createVariant(deps, {
      body: request.body,
      actor: sessionActor(sessionOf(request)),
    });
    // 201: a create publishes version 1 of a new variant.
    return reply.code(201).send(VariantDetailOut.parse(detail));
  });

  app.put("/variants/:variantId", { preHandler: writeHandler }, async (request, reply) => {
    const params = z.object({ variantId: VariantId }).safeParse(request.params);
    if (!params.success) throw badRequest("invalid_variant_id");
    await assertWritable(deps);

    const detail = await editVariant(deps, {
      variantId: params.data.variantId,
      body: request.body,
      actor: sessionActor(sessionOf(request)),
    });
    return reply.code(200).send(VariantDetailOut.parse(detail));
  });

  app.post(
    "/variants/:variantId/versions",
    { preHandler: writeHandler },
    async (request, reply) => {
      const params = z.object({ variantId: VariantId }).safeParse(request.params);
      if (!params.success) throw badRequest("invalid_variant_id");
      await assertWritable(deps);

      const detail = await publishVariantVersion(deps, {
        variantId: params.data.variantId,
        body: request.body,
        actor: sessionActor(sessionOf(request)),
      });
      // 201: publishing appends a new immutable version (M83).
      return reply.code(201).send(VariantDetailOut.parse(detail));
    },
  );

  /**
   * Cache and ticket workspaces (M4/M65) — REFUSED, and the refusal is the
   * honest answer rather than a gap somebody forgot to fill.
   *
   * The screen asks, per workspace, for the runner holding it, its size on
   * disk, its session state and its last access. Checked against the schema and
   * the ports:
   *
   *  · there is no `runner` anywhere in `schema.prisma` — no fleet table, no
   *    `runnerId` column on `WorkflowRun`. A runner reports itself to nothing,
   *    which is the same gap `DEGRADED_CAPABILITIES` already names for the
   *    `runners` read model (M60);
   *  · `RunnerPort` has `acquire`/`runSession`/`mountCache`/`release` and no
   *    size probe, so nobody can measure a workspace even on demand;
   *  · the three M4 cache layers (workspace, dependency, knowledge) have no
   *    inventory: `packages/cache` is Redis COORDINATION — token bucket, lock,
   *    semaphore — and counts neither entries nor bytes per layer.
   *
   * What DOES exist is `WorkflowRun.workspacePath` and `workspacePresent`: a
   * flag saying a clone is still on some unnamed runner. Serving that as the
   * screen's shape would mean inventing a `runnerId`, a `bytes` and a
   * `sessionState` per row — three fabricated facts to make one real flag
   * renderable — and the result would look like a measured fleet. Refusing
   * costs an operator an error; answering costs them a capacity decision made
   * on numbers nobody produced.
   *
   * This becomes real when a runner registers itself and reports its disk. Not
   * before, and not by adding a table nothing writes.
   */
  app.get("/cache", { preHandler }, async () => {
    unwired("cache");
  });
}
