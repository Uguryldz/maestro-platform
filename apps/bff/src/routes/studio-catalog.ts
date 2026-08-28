import { AppId } from "@maestro/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { toActor } from "../actor.js";
import { ASSIGNABLE_GROUPS, rolesOf } from "../auth/groups.js";
import { authGuard, requireAnyRole, sessionOf } from "../auth/guard.js";
import { accountProvisionerOf, type ResolvedDeps, type UserRecord } from "../deps.js";
import { badRequest, conflict, notFound, unavailable } from "../errors.js";
import { visibleKnowledge } from "../knowledge-policy.js";
import { pageBody, pageOf, visibleProjects } from "./paging.js";

/** The registry and the security board describe the platform (M86 admin surface). */
export const CATALOG_ROLES = ["admin", "tech-lead"] as const;

/** The role that may add, edit and off-board accounts (M8/M86). Admin alone. */
export const USER_ADMIN_ROLES = ["admin"] as const;

/** How many accounts the users table asks for; a directory is not a page. */
const USER_LIST_LIMIT = 500;

/**
 * A group an admin may assign, validated against the closed set the platform
 * knows how to map to a role. A free-text group would either grant nothing
 * (confusing) or, worse, be mistaken for one — so the write path only accepts
 * the groups `ROLE_BY_GROUP` recognises.
 */
const AssignableGroup = z.string().refine((group) => ASSIGNABLE_GROUPS.includes(group), {
  message: "unknown_group",
});

const CreateUserBody = z.object({
  /** The directory login, e.g. `ayse.kaya`; the `@corp` actor is derived from it. */
  username: z.string().trim().min(1).max(128),
  displayName: z.string().trim().min(1).max(200),
  groups: z.array(AssignableGroup).max(32),
  password: z.string().min(1).max(1024),
});

const EditUserBody = z.object({
  displayName: z.string().trim().min(1).max(200).optional(),
  groups: z.array(AssignableGroup).max(32).optional(),
  /** `false` off-boards, `true` reactivates. */
  active: z.boolean().optional(),
});

/** The account, as it leaves the BFF — never the password hash. */
function publicUser(record: UserRecord): {
  username: string;
  userId: string;
  displayName: string;
  roles: readonly string[];
  groups: readonly string[];
  active: boolean;
} {
  return {
    username: record.username,
    userId: record.userId,
    // Always a string, never optional on the wire: the screen renders this as
    // the account's heading, and a client that had to decide between a name and
    // a username would be re-implementing the fallback in a second place. The
    // ONE place that decision is made is here.
    displayName: record.displayName ?? record.username,
    roles: record.roles,
    groups: record.groups,
    active: record.active,
  };
}

/**
 * The reference data Studio renders around a run: which applications exist,
 * what the analyst knows, what the scanners found and what the gateway spent.
 */
export async function studioCatalogRoutes(app: FastifyInstance, deps: ResolvedDeps): Promise<void> {
  const preHandler = authGuard(deps);

  /**
   * The Application Registry (M100). Readable by any session: an engineer has
   * to be able to see which application their ticket was matched to, and the
   * record carries no secret — the repo path is already in every PR link.
   */
  app.get("/studio/apps", { preHandler }, async (request, reply) => {
    const page = await deps.read.apps.list(pageOf(request.query));
    return reply.code(200).send(pageBody(page));
  });

  app.get("/studio/apps/:appId", { preHandler }, async (request, reply) => {
    const appId = appIdParam(request.params);
    const record = await deps.read.apps.get(appId);
    if (record === null) throw notFound("unknown_app", { appId });
    return reply.code(200).send(record);
  });

  /**
   * The repo card (M100) — the module summary the analyst judges cross-app
   * impact from. `null` when one was never generated, which is a real state:
   * an application onboarded this morning has no card yet, and inventing an
   * empty one would let an analysis claim it checked something it did not.
   */
  app.get("/studio/apps/:appId/repo-card", { preHandler }, async (request, reply) => {
    const appId = appIdParam(request.params);
    if ((await deps.read.apps.get(appId)) === null) throw notFound("unknown_app", { appId });
    const card = await deps.read.apps.repoCard(appId);
    if (card === null) throw notFound("no_repo_card", { appId });
    return reply.code(200).send(card);
  });

  /**
   * Knowledge search (M18/M63). The data-class filter is applied HERE, on the
   * way out, and it is fail-closed: a document the index could not classify is
   * `gizli` and a session without the clearance never sees it. The count of
   * what was withheld is returned so the screen can say "3 results hidden"
   * rather than quietly showing a short list.
   */
  app.get("/studio/knowledge", { preHandler }, async (request, reply) => {
    const query = KnowledgeQuery.safeParse(request.query);
    if (!query.success) throw badRequest("invalid_query");

    const page = await deps.read.knowledge.search({
      ...pageOf(request.query),
      text: query.data.q,
      appId: query.data.appId ?? null,
    });

    const filtered = visibleKnowledge(page.items, sessionOf(request));
    return reply.code(200).send({
      items: filtered.visible,
      nextCursor: page.nextCursor,
      withheld: filtered.withheld,
    });
  });

  /**
   * Security findings (M27). Scoped per project like the runs they belong to:
   * a finding names a file and a line in somebody's repository, which is not
   * something every account with a login should be able to enumerate.
   */
  app.get("/studio/scans", { preHandler }, async (request, reply) => {
    const page = await deps.read.scans.list({
      ...pageOf(request.query),
      projectKeys: visibleProjects(sessionOf(request)),
    });
    return reply.code(200).send(pageBody(page));
  });

  /**
   * The gateway call log (M16). Platform-wide spend is an operator's view; the
   * per-run slice lives on `/studio/runs/:ticket/cost`, where the project check
   * applies. Without that split, a `runId` query parameter here would be a way
   * to read a stranger's consumption.
   */
  app.get(
    "/studio/cost",
    { preHandler: [preHandler, requireAnyRole(...CATALOG_ROLES)] },
    async (request, reply) => {
      const page = await deps.read.cost.calls({ ...pageOf(request.query), runId: null });
      return reply.code(200).send(pageBody(page));
    },
  );

  /**
   * Who holds which role (M8/M86). Admin-only and deliberately thin: the
   * directory is the source of truth, this is a window onto it, and it returns
   * no password material because `UserDirectory` is the only thing that has
   * ever seen any.
   */
  app.get(
    "/studio/users/:username",
    { preHandler: [preHandler, requireAnyRole("admin")] },
    async (request, reply) => {
      const parsed = z
        .object({ username: z.string().trim().min(1).max(128) })
        .safeParse(request.params);
      if (!parsed.success) throw badRequest("invalid_username");

      const user = await deps.users.find(parsed.data.username);
      if (user === null) throw notFound("unknown_user");
      return reply.code(200).send(publicUser(user));
    },
  );

  /**
   * The users table (M8/M86). Admin-only, and it returns the WHOLE window
   * including deactivated accounts: an admin auditing who still has access has
   * to see the off-boarded rows, not a list that quietly hides them. No
   * password material — `publicUser` is the only shape that ever leaves here.
   */
  app.get(
    "/studio/users",
    { preHandler: [preHandler, requireAnyRole(...USER_ADMIN_ROLES)] },
    async (_request, reply) => {
      const users = await deps.users.list(USER_LIST_LIMIT);
      return reply.code(200).send({ items: users.map(publicUser) });
    },
  );

  /**
   * Create a local account (M8). The password goes through the identity
   * provider so bcrypt and the policy both apply — a weak password comes back
   * as `password_policy` with the exact rules it broke, which the screen shows.
   *
   * Roles are DERIVED from groups, never accepted from the caller: authority is
   * a reading of directory membership (`rolesOf`), so an admin picks groups and
   * the platform decides what they grant. This matches how the production
   * directory re-derives roles on every read.
   */
  app.post(
    "/studio/users",
    { preHandler: [preHandler, requireAnyRole(...USER_ADMIN_ROLES)] },
    async (request, reply) => {
      const provisioner = accountProvisionerOf(deps.identity);
      // A directory that cannot mint local credentials (AD/LDAP, Aşama 2) answers
      // 503 rather than pretending to have written one it does not own.
      if (provisioner === null) throw unavailable("capability_not_wired");

      const body = CreateUserBody.safeParse(request.body);
      if (!body.success) throw badRequest("invalid_user_body");

      const username = body.data.username;
      if ((await deps.users.find(username)) !== null) {
        throw conflict("user_exists", { username });
      }

      const groups = body.data.groups;
      // `provision` throws `PasswordPolicyError` (400 `password_policy`) when the
      // password is weak — it carries the failed rules, and the server error
      // handler forwards them, so nothing is caught here.
      const record = await provisioner.provision({
        username,
        userId: toActor(username, deps.config.actorDomain),
        password: body.data.password,
        groups,
        roles: rolesOf(groups),
      });

      return reply.code(201).send(publicUser(record));
    },
  );

  /**
   * Edit an account: display name, group membership (and thus roles), or its
   * active state. This is `upsert` on an EXISTING record — the password is never
   * touched here, so a re-key is a separate, deliberate act, not a side effect
   * of changing someone's groups.
   */
  app.put(
    "/studio/users/:username",
    { preHandler: [preHandler, requireAnyRole(...USER_ADMIN_ROLES)] },
    async (request, reply) => {
      const params = z
        .object({ username: z.string().trim().min(1).max(128) })
        .safeParse(request.params);
      if (!params.success) throw badRequest("invalid_username");

      const body = EditUserBody.safeParse(request.body);
      if (!body.success) throw badRequest("invalid_user_body");

      const current = await deps.users.find(params.data.username);
      if (current === null) throw notFound("unknown_user");

      const groups = body.data.groups ?? [...current.groups];
      const next: UserRecord = {
        ...current,
        groups,
        // Roles always track groups — an edit cannot leave a stored role the
        // new group set does not grant.
        roles: rolesOf(groups),
        active: body.data.active ?? current.active,
      };
      await deps.users.upsert(next);
      return reply.code(200).send(publicUser(next));
    },
  );

  /**
   * Off-board an account (M8/M33). DEACTIVATE, not delete: a departed approver's
   * name is on closed gates and the audit trail resolves it through the
   * directory, so deleting the row would leave the trail pointing at nobody. The
   * guard treats a deactivated account exactly like a missing one, and every
   * session it holds dies at the next request — so this is a real revocation,
   * not a cosmetic flag. Idempotent: deactivating an already-off boarded account
   * is a 200, not an error.
   */
  app.delete(
    "/studio/users/:username",
    { preHandler: [preHandler, requireAnyRole(...USER_ADMIN_ROLES)] },
    async (request, reply) => {
      const params = z
        .object({ username: z.string().trim().min(1).max(128) })
        .safeParse(request.params);
      if (!params.success) throw badRequest("invalid_username");

      const current = await deps.users.find(params.data.username);
      if (current === null) throw notFound("unknown_user");

      await deps.users.remove(params.data.username);
      return reply.code(200).send(publicUser({ ...current, active: false }));
    },
  );
}

const KnowledgeQuery = z.object({
  q: z.string().trim().min(1).max(512),
  appId: z.string().trim().min(1).max(64).optional(),
});

function appIdParam(params: unknown): string {
  const parsed = z.object({ appId: AppId }).safeParse(params);
  if (!parsed.success) throw badRequest("invalid_app_id");
  return parsed.data.appId;
}
