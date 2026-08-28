/**
 * The BFF's read shape for a Jira project's WORKFLOW GRAPH — the statuses and
 * the transitions between them — as Studio's import screen reads it (M102).
 *
 * Why it lives here and not in `packages/contracts`: contracts and ports are
 * FROZEN, and Maestro's own workflow (`STEP_IDS` / `WorkflowRunStatus`) is a
 * distinct, frozen vocabulary. Jira's live statuses are NOT Maestro's steps —
 * mapping one onto the other is a new import layer, so its types are the BFF's
 * own read model, never an edit to the frozen schema.
 *
 * The port is `JiraWorkflowReader`, injected OPTIONALLY into `BffDeps`. A
 * deployment that has not wired a driver capable of reading a project's
 * workflow gets 503-by-name on the route (the `unwired` convention), never an
 * empty graph that would render as "this project has no workflow".
 *
 * The shapes mirror the adapter's `JiraWorkflowGraph` deliberately: the driver
 * normalizes live Jira into exactly this, and the reader hands it through. They
 * are re-declared here (not imported from the adapter) so the BFF's read
 * surface owns its own vocabulary and no route reaches into a driver package.
 */

/** A workflow status node — a board column, with its lifecycle category. */
export interface JiraWorkflowStatusView {
  id: string;
  name: string;
  /** `To Do` | `In Progress` | `Done`, as the site labels the status category. */
  category: string;
}

/** A transition edge. `fromStatusId` is null for a global transition (from any status). */
export interface JiraWorkflowTransitionView {
  id: string;
  name: string;
  fromStatusId: string | null;
  toStatusId: string;
}

/**
 * The normalized project workflow graph.
 *
 * `edgesComplete` and `sampledFrom` are carried through verbatim from the
 * driver — the edge set is what the sampled issues OBSERVED, not a proven-
 * complete scheme (the full workflow-scheme API is Jira-admin-only). The import
 * screen shows this honestly rather than implying a completeness it cannot have.
 */
export interface JiraWorkflowGraphView {
  projectKey: string;
  statuses: readonly JiraWorkflowStatusView[];
  transitions: readonly JiraWorkflowTransitionView[];
  edgesComplete: boolean;
  sampledFrom: readonly string[];
}

/**
 * The injected capability: read one project's workflow graph off live Jira.
 *
 * OPTIONAL in `BffDeps` — a deployment wires it from the concrete Cloud driver
 * (`JiraCloudWorkPort.readProjectWorkflow`), and one that does not answers
 * 503-by-name. Read-only: nothing here moves an issue.
 */
export interface JiraWorkflowReader {
  readProjectWorkflow(projectKey: string): Promise<JiraWorkflowGraphView>;
}
