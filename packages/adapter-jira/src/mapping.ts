import { TicketSnapshot } from "@maestro/contracts";
import { normalizeJiraDateTime } from "./datetime.js";
import { JiraResponseError } from "./errors.js";

/**
 * Jira DC REST v2 issue JSON → TicketSnapshot. No custom fields are read
 * (M98/M102: the platform demands no workflow or screen changes), so every
 * value below comes from a stock field.
 */

interface JiraUserLike {
  name?: unknown;
  key?: unknown;
  displayName?: unknown;
  emailAddress?: unknown;
}

/** DC identity: `name` is the username the PAT world uses; `key` survives renames. */
export function userIdOf(user: unknown): string | null {
  if (typeof user !== "object" || user === null) return null;
  const candidate = user as JiraUserLike;
  for (const value of [candidate.name, candidate.key, candidate.emailAddress, candidate.displayName]) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nameOf(value: unknown): string | null {
  const obj = record(value);
  const name = obj?.["name"];
  return typeof name === "string" && name.trim().length > 0 ? name.trim() : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((s) => s.trim())
    : [];
}

/**
 * Map one issue payload. The same shape arrives from `GET /issue/{key}` and
 * inside webhook envelopes, so both paths share this function — and both end
 * up validated by the contract schema.
 */
export function mapIssueToSnapshot(raw: unknown): TicketSnapshot {
  const issue = record(raw);
  if (!issue) throw new JiraResponseError("issue", ["payload is not an object"]);
  const fields = record(issue["fields"]);
  if (!fields) throw new JiraResponseError("issue.fields", ["missing fields object"]);

  const key = typeof issue["key"] === "string" ? issue["key"] : null;
  if (!key) throw new JiraResponseError("issue.key", ["missing issue key"]);

  const projectKey = nameOfProject(fields["project"]) ?? key.split("-")[0] ?? "";
  const components = Array.isArray(fields["components"])
    ? fields["components"].map((c) => nameOf(c)).filter((c): c is string => c !== null)
    : [];

  const candidate = {
    key,
    projectKey,
    issueType: nameOf(fields["issuetype"]) ?? "",
    summary: typeof fields["summary"] === "string" ? fields["summary"] : "",
    // DC returns wiki markup text (or null when the reporter left it empty).
    description: typeof fields["description"] === "string" ? fields["description"] : "",
    reporter: userIdOf(fields["reporter"]) ?? "",
    assignee: userIdOf(fields["assignee"]),
    components,
    labels: stringList(fields["labels"]),
    parentKey: parentKeyOf(fields["parent"]),
    createdAt: normalizeJiraDateTime(fields["created"], "issue.fields.created"),
    updatedAt: normalizeJiraDateTime(fields["updated"], "issue.fields.updated"),
  };

  const parsed = TicketSnapshot.safeParse(candidate);
  if (!parsed.success) {
    throw new JiraResponseError(
      `issue ${key}`,
      parsed.error.issues.map((issueDetail) => `${issueDetail.path.join(".")}: ${issueDetail.message}`),
    );
  }
  return parsed.data;
}

function nameOfProject(value: unknown): string | null {
  const project = record(value);
  const projectKey = project?.["key"];
  return typeof projectKey === "string" && projectKey.length > 0 ? projectKey : null;
}

/**
 * Sub-task parents live in `fields.parent`; next-gen "parent link" custom
 * fields are intentionally ignored (no custom field dependency — M98).
 */
function parentKeyOf(value: unknown): string | null {
  const parent = record(value);
  const parentKey = parent?.["key"];
  return typeof parentKey === "string" && parentKey.length > 0 ? parentKey : null;
}

/** Fields requested on every issue read — narrow reads keep DC load low. */
export const ISSUE_FIELDS = [
  "summary",
  "description",
  "issuetype",
  "project",
  "reporter",
  "assignee",
  "components",
  "labels",
  "parent",
  "created",
  "updated",
].join(",");
