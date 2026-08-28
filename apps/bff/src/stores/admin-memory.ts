import type {
  ConnectionView,
  NotifyDriverView,
  RoutingProjectView,
  RoutingReader,
  RoutingRuleView,
  SettingsReader,
} from "../deps.js";
import type { JiraWorkflowGraphView, JiraWorkflowReader } from "../jira-workflow-model.js";

/**
 * Reference implementations of the two admin read seams, for tests and for the
 * dev compose.
 *
 * They answer from a list they were GIVEN. That is the whole design: a fake
 * that invented a plausible connection table would make a test pass against
 * data no deployment has, and the composition root would still be free to ship
 * without wiring the real reader. Constructed empty they answer empty, and the
 * screens render "nothing configured" — which is the truth about a store
 * holding nothing, and is why the composition root uses the Postgres-backed
 * and environment-backed readers instead of these.
 */

export class StaticSettingsReader implements SettingsReader {
  constructor(
    private readonly connectionRows: readonly ConnectionView[] = [],
    private readonly driverRows: readonly NotifyDriverView[] = [],
  ) {}

  connections(): Promise<readonly ConnectionView[]> {
    return Promise.resolve(this.connectionRows.map((row) => ({ ...row })));
  }

  notifyDrivers(): Promise<readonly NotifyDriverView[]> {
    return Promise.resolve(this.driverRows.map((row) => ({ ...row })));
  }
}

/**
 * A workflow reader that answers from a per-project graph it was GIVEN.
 *
 * Same design as the two above: it invents nothing. A project it was not seeded
 * with is a project this fake cannot read, and it says so by throwing — the
 * composition root wires the real reader (the Cloud driver's
 * `readProjectWorkflow`), and a test seeds exactly the graph it asserts on. A
 * fake that returned an empty graph for an unknown project would let a route
 * pass against a workflow no site has.
 */
export class StaticJiraWorkflowReader implements JiraWorkflowReader {
  private readonly byProject: Map<string, JiraWorkflowGraphView>;

  constructor(graphs: readonly JiraWorkflowGraphView[] = []) {
    this.byProject = new Map(graphs.map((g) => [g.projectKey, g]));
  }

  readProjectWorkflow(projectKey: string): Promise<JiraWorkflowGraphView> {
    const graph = this.byProject.get(projectKey);
    if (graph === undefined) {
      return Promise.reject(new Error(`no seeded workflow for project ${projectKey}`));
    }
    return Promise.resolve({
      ...graph,
      statuses: graph.statuses.map((s) => ({ ...s })),
      transitions: graph.transitions.map((t) => ({ ...t })),
      sampledFrom: [...graph.sampledFrom],
    });
  }
}

export class StaticRoutingReader implements RoutingReader {
  constructor(
    private readonly projectRows: readonly RoutingProjectView[] = [],
    private readonly ruleRows: readonly RoutingRuleView[] = [],
  ) {}

  projects(): Promise<readonly RoutingProjectView[]> {
    return Promise.resolve(this.projectRows.map((row) => ({ ...row, apps: [...row.apps] })));
  }

  rules(): Promise<readonly RoutingRuleView[]> {
    return Promise.resolve(this.ruleRows.map((row) => ({ ...row })));
  }
}
