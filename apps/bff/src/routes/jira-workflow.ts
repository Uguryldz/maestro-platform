import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authGuard, requireAnyRole } from "../auth/guard.js";
import type { ResolvedDeps } from "../deps.js";
import { badRequest } from "../errors.js";
import type { JiraWorkflowReader } from "../jira-workflow-model.js";
import { unwired } from "./unwired.js";

/**
 * The workflow-IMPORT surface (M102): read a Jira project's live statuses and
 * the transitions between them, so Studio can show the operator the real
 * workflow their tickets move through and map it onto Maestro's steps.
 *
 * This is an ADMIN surface, like the settings and routing screens beside it: it
 * describes how the PLATFORM is wired to a Jira project, not a piece of work, so
 * it is read by `admin` and `tech-lead` and by no one else (M86).
 *
 * Read-only and refuses honestly. The reader is OPTIONAL in `BffDeps`; a
 * deployment that wired no driver capable of reading a project's workflow gets
 * 503-by-name (the `unwired` convention) rather than an empty graph that would
 * render as "this project has no workflow". Nothing here writes — importing a
 * workflow reads live Jira; it never moves an issue.
 */

const READ_ROLES = ["admin", "tech-lead"] as const;

/**
 * The project key comes off the query string. A Jira project key is a short
 * uppercase-ish identifier; the guard keeps a caller from smuggling a path
 * segment or JQL fragment into the value the reader interpolates. The reader
 * still quotes it — this is belt-and-braces, not the only defence.
 */
const WorkflowQuery = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z][A-Za-z0-9_]*$/, "project must be a bare Jira project key"),
});

/**
 * Both the reader and its being wired, or a named refusal. A route that read
 * `deps.jiraWorkflow` directly would answer 500 on an unwired deployment; the
 * gate turns that into the 503-by-name an operator can act on.
 */
function workflowReader(deps: ResolvedDeps): JiraWorkflowReader {
  if (deps.jiraWorkflow === undefined) unwired("jira-workflow");
  return deps.jiraWorkflow;
}

export async function jiraWorkflowRoutes(app: FastifyInstance, deps: ResolvedDeps): Promise<void> {
  const readHandler = [authGuard(deps), requireAnyRole(...READ_ROLES)];

  /**
   * `GET /studio/jira-workflow?project=OPS` → the normalized workflow graph.
   *
   * The body is the driver's honest shape: authoritative status NODES, the
   * OBSERVED transition EDGES, and the `edgesComplete: false` / `sampledFrom`
   * flags that say the edge set was sampled, not proven complete.
   */
  app.get("/studio/jira-workflow", { preHandler: readHandler }, async (request, reply) => {
    const reader = workflowReader(deps);
    const query = WorkflowQuery.safeParse(request.query);
    if (!query.success) throw badRequest("invalid_project");

    const graph = await reader.readProjectWorkflow(query.data.project);
    return reply.code(200).send(graph);
  });
}
