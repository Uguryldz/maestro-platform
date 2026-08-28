import { AppId } from "@maestro/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sessionActor } from "../actor.js";
import { authGuard, requireAnyRole, sessionOf } from "../auth/guard.js";
import type { ResolvedDeps } from "../deps.js";
import { badRequest, notFound } from "../errors.js";
import type { RepoPolicyRecord } from "../onboarding-models.js";
import { assertWritable } from "../platform/propose.js";
import {
  addRepoAddition,
  removeRepoAddition,
  renderPolicyYaml,
  PLATFORM_DEFAULT_PATHS,
} from "../repo-policy-service.js";
import { pageOf } from "./paging.js";

/**
 * `.maestro.yaml` (M52/M71): the repo-native half of a project's configuration.
 *
 * The file is READ-ONLY here and that is a product decision — it lives in the
 * repository so the team owns it through their own PR process. Protected paths
 * are the one editing affordance, and even there the platform defaults are a
 * floor: a repo may ADD to the deny-list and may never shrink it.
 */
export const REPO_POLICY_ROLES = ["admin", "tech-lead"] as const;

/** `RepoPolicy` in `screens/common/admin-api.ts` — the shape the screen renders. */
const PolicyBody = z.object({
  appId: z.string(),
  platform: z.string(),
  repo: z.string(),
  /**
   * The rendered file, or "" when no run has observed one.
   *
   * Empty rather than a comment block explaining the absence: that explanation
   * is a SENTENCE to a user, and the BFF does not send sentences (M104). The
   * screen renders it from its own catalog, in the operator's language —
   * previously this string arrived in English on a Turkish screen.
   */
  yaml: z.string(),
  /**
   * Whether a run has ever read this repository's `.maestro.yaml`.
   *
   * Carried explicitly instead of being inferred from `yaml === ""`: a file
   * that exists but declares nothing is a real and different state from a file
   * nobody has seen, and M52 stops the flow only for the second.
   */
  yamlPresent: z.boolean(),
  protectedPaths: z.object({
    platformDefaults: z.array(z.string()),
    repoAdditions: z.array(z.string()),
  }),
  fetchedAt: z.string().nullable(),
});

const PolicyView = z.object({ policies: z.array(PolicyBody) });

/**
 * A path the caller wants added. Length-capped and non-empty; the SHAPE of a
 * glob is checked by `compileProtectedPath` in the service, which is the
 * platform's own compiler rather than a second regex that could drift from it.
 */
const PathBody = z.object({ path: z.string().trim().min(1).max(256) }).strict();

export async function repoPolicyRoutes(app: FastifyInstance, deps: ResolvedDeps): Promise<void> {
  const preHandler = [authGuard(deps), requireAnyRole(...REPO_POLICY_ROLES)];

  /**
   * Every application's policy (M52/M71).
   *
   * A registry with no applications yields `{policies: []}` and that is honest:
   * the read model itself refuses when its store is not wired, so an empty list
   * here means the registry was read and holds nothing — not that nobody asked.
   */
  app.get("/repo-policy", { preHandler }, async (request, reply) => {
    const records = await deps.read.repoPolicy.list(pageOf(request.query));
    const overrides = await storedAdditions(deps);
    const policies = records.map((record) => toWire(withOverrides(record, overrides)));
    return reply.code(200).send(PolicyView.parse({ policies }));
  });

  app.get("/repo-policy/:appId", { preHandler }, async (request, reply) => {
    const record = await policyOf(deps, appIdParam(request.params));
    return reply.code(200).send(PolicyBody.parse(toWire(record)));
  });

  /**
   * The deny-list as two halves (M52). Split in the response rather than in the
   * screen, because which half a path belongs to is the server's fact: the
   * defaults come from `@maestro/execution` and the additions from the repo.
   */
  app.get("/repo-policy/:appId/protected-paths", { preHandler }, async (request, reply) => {
    const record = await policyOf(deps, appIdParam(request.params));
    return reply.code(200).send(PolicyBody.parse(toWire(record)).protectedPaths);
  });

  /**
   * Widen the deny-list for one repo.
   *
   * Adding is the only direction this endpoint moves in, which is why it is a
   * POST of a single path rather than a PUT of the whole list: a PUT would let
   * a client send a list with a default missing and force the server to decide
   * whether that is an attempt to remove it or a stale copy. There is no such
   * ambiguity in "add this one".
   */
  app.post("/repo-policy/:appId/protected-paths", { preHandler }, async (request, reply) => {
    const appId = appIdParam(request.params);
    const parsed = PathBody.safeParse(request.body);
    if (!parsed.success) throw badRequest("invalid_path");

    await assertWritable(deps);
    const record = await policyOf(deps, appId);
    const additions = addRepoAddition(record.repoAdditions, parsed.data.path);

    await persist(deps, appId, additions, request, "PROTECTED_PATH_ADDED", parsed.data.path);
    return reply.code(200).send(PolicyBody.parse(toWire({ ...record, repoAdditions: additions })));
  });

  /**
   * Narrow the deny-list — for a repo ADDITION only.
   *
   * A platform default is refused here by name (`protected_path_is_default`,
   * 409). That refusal is the whole point of M52's floor: `DEFAULT_PROTECTED_PATHS`
   * covers migrations, CI definitions, git hooks and secret material, and a
   * repo that could delete one could hand an agent write access to the build
   * machine. The screen already renders the defaults without a delete control,
   * so this path is reached by a client that went around the UI.
   */
  app.delete(
    "/repo-policy/:appId/protected-paths/:path",
    { preHandler },
    async (request, reply) => {
      const appId = appIdParam(request.params);
      const parsed = z
        .object({ appId: z.string(), path: z.string().trim().min(1).max(256) })
        .safeParse(request.params);
      if (!parsed.success) throw badRequest("invalid_path");

      await assertWritable(deps);
      const record = await policyOf(deps, appId);
      const additions = removeRepoAddition(record.repoAdditions, parsed.data.path);

      await persist(deps, appId, additions, request, "PROTECTED_PATH_REMOVED", parsed.data.path);
      return reply.code(200).send(PolicyBody.parse(toWire({ ...record, repoAdditions: additions })));
    },
  );
}

/**
 * The record, or a 404 that names the application.
 *
 * `null` from the read model means the app is not in the registry — a typo or a
 * repo nobody onboarded. Returning an empty policy instead would show the
 * operator a `.maestro.yaml` screen for an application that does not exist,
 * with an empty deny-list that reads as "nothing is protected here".
 */
async function policyOf(deps: ResolvedDeps, appId: string): Promise<RepoPolicyRecord> {
  const record = await deps.read.repoPolicy.get(appId);
  if (record === null) throw notFound("unknown_app", { appId });
  return withOverrides(record, await storedAdditions(deps));
}

/**
 * The deny-list additions Studio has written, per application.
 *
 * They live in the parameter store because that is the only durable place this
 * endpoint can write to today: the authoritative copy of `.maestro.yaml` is in
 * the REPOSITORY, and putting one there means opening a pull request (which is
 * what the screen's own note promises). Until that PR path exists, an edit made
 * here has to survive the next read — otherwise the operator adds a path, the
 * list re-renders without it, and they cannot tell a failed write from a
 * refused one.
 *
 * The stored value wins over the observed one because it is the more recent
 * statement of intent: the run column records what the file said when it was
 * last cloned, and this records what an admin asked for since.
 */
async function storedAdditions(deps: ResolvedDeps): Promise<ReadonlyMap<string, string[]>> {
  const pending = await deps.params.pending();
  const byApp = new Map<string, string[]>();
  for (const entry of pending) {
    if (entry.key !== PROTECTED_PATHS_PARAM || entry.scopeRef === null) continue;
    if (!Array.isArray(entry.value)) continue;
    if (!entry.value.every((path) => typeof path === "string")) continue;
    byApp.set(entry.scopeRef, [...(entry.value as string[])]);
  }
  return byApp;
}

function withOverrides(
  record: RepoPolicyRecord,
  overrides: ReadonlyMap<string, string[]>,
): RepoPolicyRecord {
  const stored = overrides.get(record.appId);
  return stored === undefined ? record : { ...record, repoAdditions: stored };
}

/**
 * Write the new addition list through the param store's four-eyes-free channel.
 *
 * Protected paths widen or narrow a deny-list for ONE repo and are stored as an
 * unguarded scoped parameter, so they apply immediately — unlike a binding,
 * which redirects a whole project's tickets and takes an approver. The audit
 * record is written either way, because "who removed the payment-core guard"
 * is a question an auditor will ask.
 */
async function persist(
  deps: ResolvedDeps,
  appId: string,
  additions: readonly string[],
  request: Parameters<typeof sessionOf>[0],
  action: string,
  path: string,
): Promise<void> {
  const actor = sessionActor(sessionOf(request));
  const at = deps.clock.now().toISOString();

  await deps.params.putPending({
    key: PROTECTED_PATHS_PARAM,
    scopeRef: appId,
    value: [...additions],
    proposedBy: actor,
    at,
  });
  await deps.audit.append({
    actor,
    action: "PARAM_CHANGED",
    subject: `repo-policy:${appId}`,
    at,
    meta: { change: action, path, appId, additions: [...additions] },
  });
}

/** Where a repo's deny-list additions are stored, scoped per application (M71). */
export const PROTECTED_PATHS_PARAM = "repo.protected_paths";

/** The record as the screen reads it, with the platform floor spelled out. */
function toWire(record: RepoPolicyRecord): z.input<typeof PolicyBody> {
  return {
    appId: record.appId,
    platform: record.platform,
    repo: record.repo,
    yaml: renderPolicyYaml(record),
    yamlPresent: record.yamlPresent,
    protectedPaths: {
      platformDefaults: [...PLATFORM_DEFAULT_PATHS],
      repoAdditions: [...record.repoAdditions],
    },
    fetchedAt: record.observedAt,
  };
}

function appIdParam(params: unknown): string {
  const parsed = z.object({ appId: AppId }).safeParse(params);
  if (!parsed.success) throw badRequest("invalid_app_id");
  return parsed.data.appId;
}
