import { JiraArgumentError, JiraResponseError } from "../errors.js";
import type { JiraCloudClient } from "./client.js";

/**
 * Issue search on Jira Cloud. The old `/rest/api/3/search` endpoint is GONE
 * (Atlassian CHANGE-2046 — calling it returns an error pointing here), so the
 * driver only speaks `/rest/api/3/search/jql`. That endpoint additionally
 * REJECTS unbounded JQL ("Burada sınırsız JQL'lere izin verilmez" on the
 * recorded site), so the driver refuses to send one instead of letting the
 * server answer with an opaque 4xx.
 */

const SEARCH_PATH = "/rest/api/3/search/jql";

export interface CloudSearchRequest {
  jql: string;
  maxResults?: number;
  /** Field names to return per issue; omitted → the server's minimal set. */
  fields?: string[];
  /** `nextPageToken` from a previous page to continue the same search. */
  pageToken?: string;
}

/**
 * One result page, exactly as the recorded response shapes it
 * (fixtures/cloud/search-jql.json): an `issues` array plus `isLast`, with a
 * `nextPageToken` cursor when more pages exist. No `total` — the new
 * endpoint does not send one, and the driver does not invent it.
 */
export interface CloudSearchPage {
  /** Raw issue payloads — map with mapCloudIssueToSnapshot when the requested fields allow it. */
  issues: unknown[];
  isLast: boolean;
  nextPageToken: string | null;
}

/**
 * Refuse JQL the endpoint is known to reject: empty queries and queries that
 * are nothing but an ORDER BY carry no restriction. Any real clause
 * (`project = X`, `key = Y`, …) bounds the query, so this guard has no false
 * positives — the caller gets a typed error naming the fix, not a raw 4xx.
 */
export function assertBoundedJql(jql: string): string {
  const trimmed = jql.trim();
  if (trimmed.length === 0 || /^order\s+by\b/i.test(trimmed)) {
    throw new JiraArgumentError(
      "jql",
      `unbounded JQL is rejected by ${SEARCH_PATH} — add a restriction such as 'project = X'`,
    );
  }
  return trimmed;
}

export async function searchIssues(client: JiraCloudClient, request: CloudSearchRequest): Promise<CloudSearchPage> {
  const jql = assertBoundedJql(request.jql);
  const raw = await client.get<unknown>(SEARCH_PATH, {
    jql,
    maxResults: request.maxResults,
    fields: request.fields && request.fields.length > 0 ? request.fields.join(",") : undefined,
    nextPageToken: request.pageToken,
  });

  const body = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
  const issues = body?.["issues"];
  if (!Array.isArray(issues)) throw new JiraResponseError("search/jql", ["response carries no issues array"]);
  const isLast = body?.["isLast"];
  if (typeof isLast !== "boolean") throw new JiraResponseError("search/jql", ["response carries no boolean isLast"]);
  const nextPageToken = body?.["nextPageToken"];

  return {
    issues,
    isLast,
    nextPageToken: typeof nextPageToken === "string" && nextPageToken.length > 0 ? nextPageToken : null,
  };
}
