import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sessionActor } from "../actor.js";
import { authGuard, requireAnyRole, sessionOf } from "../auth/guard.js";
import type { ResolvedDeps } from "../deps.js";
import { badRequest, notFound } from "../errors.js";
import { publishTemplateVersion, readTemplate } from "../template-service.js";

/**
 * Who may read and publish the analysis template (M108).
 *
 * The template decides what every analysis in the institution is asked to
 * contain, and the analysis is what a human gate approves — so it sits with the
 * same two roles that own the operational parameters, not with everyone holding
 * a session.
 */
export const TEMPLATE_ROLES = ["admin", "tech-lead"] as const;

const PublishBody = z.object({
  name: z.string(),
  /** Validated field-by-field in the service so the error names the section. */
  sections: z.array(z.unknown()),
});

const VersionParams = z.object({ version: z.coerce.number().int().positive() });

/**
 * The analysis template designer's endpoints (M108).
 *
 * `POST /template/versions` PUBLISHES a new version; it never edits one. Runs
 * already in flight keep the version they started on (M83 pinning), which is
 * why `GET /template/versions/:version` exists at all: a pinned run, and an
 * auditor asking "what did version 4 require", must be able to read a version
 * that is no longer the newest.
 */
export async function templateRoutes(app: FastifyInstance, deps: ResolvedDeps): Promise<void> {
  const preHandler = [authGuard(deps), requireAnyRole(...TEMPLATE_ROLES)];

  app.get("/template", { preHandler }, async (_request, reply) => {
    return reply.code(200).send(await readTemplate(deps));
  });

  /** A specific published version — immutable, and readable after v5 lands. */
  app.get("/template/versions/:version", { preHandler }, async (request, reply) => {
    const params = VersionParams.safeParse(request.params);
    if (!params.success) throw badRequest("invalid_template_version");

    const record = await deps.templates.get(params.data.version);
    if (record === null) throw notFound("template_version_not_found", { version: params.data.version });
    return reply.code(200).send(record);
  });

  app.post("/template/versions", { preHandler }, async (request, reply) => {
    const body = PublishBody.safeParse(request.body);
    if (!body.success) throw badRequest("invalid_template_body");

    const published = await publishTemplateVersion(deps, {
      name: body.data.name,
      sections: body.data.sections,
      actor: sessionActor(sessionOf(request)),
    });
    // 201: a save creates a new version rather than updating the current one.
    return reply.code(201).send(published);
  });
}
