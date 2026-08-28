import { TicketSnapshot } from "@maestro/contracts";
import { adfToPlainText, isAdfDoc } from "../adf.js";
import { normalizeJiraDateTime } from "../datetime.js";
import { JiraResponseError } from "../errors.js";

/**
 * Jira Cloud REST v3 issue JSON → TicketSnapshot. Shaped by the recorded
 * fixtures in fixtures/cloud/ (uyildiz.atlassian.net, project OPS), not by
 * memory of the API. The differences to the DC mapper: the description is an
 * ADF document (flattened to plain text) and users are identified by
 * `accountId` — Cloud has no username, and GDPR lets a site hide e-mails.
 */

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nameOf(value: unknown): string | null {
  const name = record(value)?.["name"];
  return typeof name === "string" && name.trim().length > 0 ? name.trim() : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((s) => s.trim())
    : [];
}

/**
 * Cloud identity: `accountId` is the only stable identifier (it is what
 * assign() and the SoD matrix use); the e-mail is a fallback for sites that
 * expose it. `displayName` is NOT an identity — same reasoning as on DC.
 */
export function cloudUserIdOf(user: unknown): string | null {
  const obj = record(user);
  if (!obj) return null;
  for (const value of [obj["accountId"], obj["emailAddress"]]) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

/** ADF description → plain text; `null` and legacy plain strings tolerated. */
export function cloudDescriptionText(value: unknown): string {
  if (isAdfDoc(value)) return adfToPlainText(value);
  return typeof value === "string" ? value : "";
}

/**
 * Map one Cloud issue payload (GET /rest/api/3/issue/{key}). Next-gen
 * ("team-managed") projects may serve empty or missing `components` — the
 * fixture project does — so absence maps to an empty list, never a failure.
 */
export function mapCloudIssueToSnapshot(raw: unknown): TicketSnapshot {
  const issue = record(raw);
  if (!issue) throw new JiraResponseError("cloud issue", ["payload is not an object"]);
  const fields = record(issue["fields"]);
  if (!fields) throw new JiraResponseError("cloud issue.fields", ["missing fields object"]);

  const key = typeof issue["key"] === "string" ? issue["key"] : null;
  if (!key) throw new JiraResponseError("cloud issue.key", ["missing issue key"]);

  const project = record(fields["project"]);
  const projectKey = typeof project?.["key"] === "string" && project["key"].length > 0
    ? project["key"]
    : (key.split("-")[0] ?? "");
  const components = Array.isArray(fields["components"])
    ? fields["components"].map((c) => nameOf(c)).filter((c): c is string => c !== null)
    : [];
  const parent = record(fields["parent"]);
  const parentKey = typeof parent?.["key"] === "string" && parent["key"].length > 0 ? parent["key"] : null;

  const candidate = {
    key,
    projectKey,
    issueType: nameOf(fields["issuetype"]) ?? "",
    summary: typeof fields["summary"] === "string" ? fields["summary"] : "",
    description: cloudDescriptionText(fields["description"]),
    reporter: cloudUserIdOf(fields["reporter"]) ?? "",
    assignee: cloudUserIdOf(fields["assignee"]),
    components,
    labels: stringList(fields["labels"]),
    parentKey,
    createdAt: normalizeJiraDateTime(fields["created"], "issue.fields.created"),
    updatedAt: normalizeJiraDateTime(fields["updated"], "issue.fields.updated"),
  };

  const parsed = TicketSnapshot.safeParse(candidate);
  if (!parsed.success) {
    throw new JiraResponseError(
      `cloud issue ${key}`,
      parsed.error.issues.map((issueDetail) => `${issueDetail.path.join(".")}: ${issueDetail.message}`),
    );
  }
  return parsed.data;
}
