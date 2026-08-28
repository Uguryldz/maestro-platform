import { JiraArgumentError, JiraResponseError } from "../errors.js";
import type { JiraCloudClient } from "./client.js";

/**
 * Reading a Jira project's WORKFLOW GRAPH — its statuses and the transitions
 * between them — off a live Cloud site, for Studio's import screen.
 *
 * A deliberate honesty note on completeness. The full workflow-scheme API
 * (`/rest/api/3/workflow*`) is Jira-admin-only; a service account scoped to a
 * single project cannot read it. What a project-scoped account CAN read is:
 *
 *   · GET /rest/api/3/project/{key}/statuses — every status the project uses,
 *     grouped by issue type, WITH the status category (To Do / In Progress /
 *     Done). This is authoritative for the NODES of the graph.
 *   · GET /rest/api/3/issue/{key}/transitions — the transitions available FROM
 *     a specific issue's CURRENT status. This is the only transition source a
 *     non-admin has, and it is inherently partial: it sees the out-edges of one
 *     node at a time.
 *
 * So the graph's EDGES are assembled by sampling: given a handful of issues
 * sitting in different statuses, the union of their available transitions
 * approximates the project's transition graph. An edge's `fromStatusId` is the
 * sampled issue's current status; a transition Jira marks `isGlobal` (available
 * from any status) is recorded with `fromStatusId: null`. This is stated on the
 * output (`edgesComplete: false`, `sampledFrom`) rather than hidden — an import
 * screen must be able to say "these are the transitions we OBSERVED", not
 * pretend to a complete scheme it could not read.
 *
 * NOTHING here writes. The driver's `transition()` stays a
 * CapabilityNotSupported no-op (M102 parity); this is a read-only import layer
 * that maps live Jira onto Studio, and does not move any issue.
 */

/** A workflow status node — a column on the board, with its lifecycle category. */
export interface JiraWorkflowStatus {
  id: string;
  name: string;
  /** `To Do` | `In Progress` | `Done` — the status-category KEY-ish name Jira returns. */
  category: string;
}

/** A transition edge. `fromStatusId` is null for a global transition (from any status). */
export interface JiraWorkflowTransition {
  id: string;
  name: string;
  fromStatusId: string | null;
  toStatusId: string;
}

/** The normalized project workflow graph handed to Studio's import screen. */
export interface JiraWorkflowGraph {
  projectKey: string;
  statuses: JiraWorkflowStatus[];
  transitions: JiraWorkflowTransition[];
  /**
   * Honesty flags. The nodes are authoritative (read from the project's status
   * list); the edges are the UNION observed across the sampled issues, so the
   * caller is told which issues were sampled and that the edge set is not proven
   * complete. Never silently presented as a full workflow scheme.
   */
  edgesComplete: boolean;
  sampledFrom: string[];
}

/** How many issues to sample transitions from, and the JQL used to find them. */
export interface JiraWorkflowReadOptions {
  /** Upper bound on issues sampled for transitions. Defaults to 10, capped at 50. */
  sampleSize?: number;
}

const API = "/rest/api/3";
const DEFAULT_SAMPLE = 10;
const MAX_SAMPLE = 50;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number") return String(value);
  return null;
}

/**
 * The status category as Jira reports it. Cloud shapes it as
 * `statusCategory: { key: "indeterminate", name: "In Progress", … }`; the
 * human-facing `name` is the useful label for an import screen, with the
 * machine `key` as a fallback. `undefined` category maps to the empty string —
 * a status with no reported category is a fact, not a failure.
 */
function categoryOf(status: Record<string, unknown>): string {
  const cat = record(status["statusCategory"]);
  if (!cat) return "";
  return nonEmptyString(cat["name"]) ?? nonEmptyString(cat["key"]) ?? "";
}

/**
 * Normalize GET /project/{key}/statuses into a de-duplicated status list.
 *
 * The endpoint groups statuses BY ISSUE TYPE, so the same status ("Yapılacaklar")
 * appears once per issue type that uses it. We flatten and de-duplicate by
 * status id — the graph has one node per status, not one per (status, type).
 * A payload that is not the expected array-of-issue-types fails loudly rather
 * than yielding an empty graph that would render as "this project has no
 * workflow".
 */
export function normalizeProjectStatuses(raw: unknown): JiraWorkflowStatus[] {
  if (!Array.isArray(raw)) {
    throw new JiraResponseError("project statuses", ["response is not an array of issue-type status groups"]);
  }
  const byId = new Map<string, JiraWorkflowStatus>();
  for (const group of raw) {
    const groupRec = record(group);
    const statuses = groupRec?.["statuses"];
    if (!Array.isArray(statuses)) continue; // an issue-type entry with no statuses is benign
    for (const entry of statuses) {
      const status = record(entry);
      if (!status) continue;
      const id = nonEmptyString(status["id"]);
      const name = nonEmptyString(status["name"]);
      if (id === null || name === null) continue; // a nameless/idless status is not a graph node
      if (!byId.has(id)) byId.set(id, { id, name, category: categoryOf(status) });
    }
  }
  return [...byId.values()];
}

/**
 * Normalize GET /project/{key}/statuses into the project's ISSUE TYPE names.
 *
 * The same payload the workflow reader uses groups statuses by issue type, so
 * the top-level `name` of each group ("Görev", "Hata") is the issue-type name a
 * listening rule matches on. De-duplicated and order-preserving; subtask types
 * are kept (a rule may legitimately target them). A non-array payload is not an
 * error here — the caller falls back to free text — so this returns [] rather
 * than throwing, unlike the status normaliser whose empty result would be a bug.
 */
export function normalizeProjectIssueTypes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of raw) {
    const name = nonEmptyString(record(group)?.["name"]);
    if (name !== null && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * Normalize one issue's GET /issue/{key}/transitions payload into edges rooted
 * at that issue's current status. `fromStatusId` is the issue's current status
 * (or null when it could not be read); a transition Jira flags `isGlobal` is
 * recorded as a global edge (`fromStatusId: null`) so it is not mis-attributed
 * to the one status we happened to observe it from.
 */
export function normalizeIssueTransitions(
  raw: unknown,
  fromStatusId: string | null,
): JiraWorkflowTransition[] {
  const body = record(raw);
  const transitions = body?.["transitions"];
  if (!Array.isArray(transitions)) {
    throw new JiraResponseError("issue transitions", ["response carries no transitions array"]);
  }
  const edges: JiraWorkflowTransition[] = [];
  for (const entry of transitions) {
    const transition = record(entry);
    if (!transition) continue;
    const id = nonEmptyString(transition["id"]);
    const name = nonEmptyString(transition["name"]);
    const to = record(transition["to"]);
    const toStatusId = to ? nonEmptyString(to["id"]) : null;
    if (id === null || name === null || toStatusId === null) continue;
    const isGlobal = transition["isGlobal"] === true;
    edges.push({ id, name, fromStatusId: isGlobal ? null : fromStatusId, toStatusId });
  }
  return edges;
}

/**
 * Merge per-issue edge lists into one de-duplicated transition graph.
 *
 * Two sampled issues in the same status yield the same out-edges; a global
 * transition observed from several statuses collapses to one null-rooted edge.
 * De-duplication is by the (fromStatusId, toStatusId, transitionId) triple —
 * the same transition id can legitimately appear from different source statuses
 * (a per-status transition of the same name), and both are real edges.
 */
export function mergeTransitionGraph(
  perIssue: readonly JiraWorkflowTransition[][],
): JiraWorkflowTransition[] {
  const byKey = new Map<string, JiraWorkflowTransition>();
  for (const edges of perIssue) {
    for (const edge of edges) {
      const key = `${edge.fromStatusId ?? "*"}|${edge.toStatusId}|${edge.id}`;
      if (!byKey.has(key)) byKey.set(key, edge);
    }
  }
  return [...byKey.values()];
}

/**
 * Live workflow reader over the Cloud driver's REST client. Reads the project's
 * status nodes, samples a bounded set of issues for their available transitions,
 * and returns the merged graph — honestly flagged as an observed (not proven
 * complete) edge set.
 */
export class JiraCloudWorkflowReader {
  constructor(private readonly client: JiraCloudClient) {}

  async readProjectWorkflow(
    projectKey: string,
    options: JiraWorkflowReadOptions = {},
  ): Promise<JiraWorkflowGraph> {
    const key = projectKey.trim();
    if (key.length === 0) throw new JiraArgumentError("project", "empty");
    const sampleSize = clampSample(options.sampleSize);

    const statusesRaw = await this.client.get<unknown>(
      `${API}/project/${encodeURIComponent(key)}/statuses`,
    );
    const statuses = normalizeProjectStatuses(statusesRaw);
    const knownStatusIds = new Set(statuses.map((s) => s.id));

    // Sample issues across the project, newest first, reading each one's current
    // status and its available transitions. Bounded search — never unbounded JQL.
    const searchRaw = await this.client.get<unknown>(`${API}/search/jql`, {
      jql: `project = ${quoteJql(key)} ORDER BY updated DESC`,
      maxResults: sampleSize,
      fields: "status",
    });
    const issues = issuesOf(searchRaw);

    const sampledFrom: string[] = [];
    const perIssue: JiraWorkflowTransition[][] = [];
    for (const issue of issues.slice(0, sampleSize)) {
      const issueKey = nonEmptyString(record(issue)?.["key"]);
      if (issueKey === null) continue;
      const currentStatusId = currentStatusIdOf(issue);
      // Only attribute an edge to a status the project actually declares; an
      // unknown status id would add a phantom node no column maps to.
      const fromStatusId =
        currentStatusId !== null && knownStatusIds.has(currentStatusId) ? currentStatusId : null;
      const transitionsRaw = await this.client.get<unknown>(
        `${API}/issue/${encodeURIComponent(issueKey)}/transitions`,
      );
      perIssue.push(normalizeIssueTransitions(transitionsRaw, fromStatusId));
      sampledFrom.push(issueKey);
    }

    return {
      projectKey: key,
      statuses,
      transitions: mergeTransitionGraph(perIssue),
      // The nodes are authoritative; the edges are only what the sample showed.
      // Never claim completeness the issue-transitions API cannot give.
      edgesComplete: false,
      sampledFrom,
    };
  }
}

function clampSample(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_SAMPLE;
  const n = Math.floor(value);
  if (n < 1) return 1;
  if (n > MAX_SAMPLE) return MAX_SAMPLE;
  return n;
}

/** A project key is a bare identifier, but quote it so a stray character cannot break the JQL. */
function quoteJql(key: string): string {
  return `"${key.replace(/"/g, '\\"')}"`;
}

function issuesOf(raw: unknown): unknown[] {
  const issues = record(raw)?.["issues"];
  return Array.isArray(issues) ? issues : [];
}

function currentStatusIdOf(issue: unknown): string | null {
  const fields = record(record(issue)?.["fields"]);
  const status = record(fields?.["status"]);
  return status ? nonEmptyString(status["id"]) : null;
}
