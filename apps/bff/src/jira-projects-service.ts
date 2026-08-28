import type { ConnectionKind } from "@maestro/contracts";
import type { ConnectionRecord } from "./connection-store.js";
import type { ConnectorFetch } from "./connection-service.js";

/**
 * Listing the Jira projects a stored connection can reach (onboarding, Faz E).
 *
 * The sibling of `scm-repos-service.ts`: same discipline — the URL is built from
 * the connection's STORED `baseUrl`, the STORED token is presented with the
 * kind's header (Cloud uses Basic with the account email, Data Center a bearer,
 * exactly as `probeFor` does), and nothing the caller sent reaches the request.
 * A failure is a secret-free catalog key, never a stack trace that could carry
 * the token.
 *
 * This lives OUTSIDE the frozen ports for the same reason the SCM and
 * Jira-workflow readers do: it is a new live read the wizard needs, not a
 * capability any port models.
 */

/** One Jira project as the wizard needs it: the key it binds on and a label. */
export interface JiraProject {
  /** The project key (`UGURPAY`) — what a binding and a ticket prefix use. */
  readonly key: string;
  /** The human name, for the dropdown label. */
  readonly name: string;
}

/** The outcome of a project listing: the projects, or a secret-free failure key. */
export type JiraProjectsResult =
  | { readonly ok: true; readonly projects: readonly JiraProject[] }
  | { readonly ok: false; readonly messageKey: string; readonly messageParams?: Record<string, string> };

/** How to list projects for one Jira kind: a path + header + a body reader. */
interface ProjectSource {
  path: string;
  header(token: string, email: string): Record<string, string>;
  parse(body: unknown): readonly JiraProject[];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function basic(user: string, token: string): string {
  return `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;
}

/**
 * Read `{ key, name }` out of a Jira project entry, tolerating the two shapes
 * the Cloud `/project/search` (wrapped in `values`) and DC `/project` (a bare
 * array) return — each element itself carries `key` and `name`.
 */
function readProjects(entries: unknown): readonly JiraProject[] {
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry): JiraProject[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const key = str(record["key"]);
    if (key === undefined) return [];
    return [{ key, name: str(record["name"]) ?? key }];
  });
}

/**
 * The project source per Jira kind. Only `jira_cloud` and `jira_dc` list;
 * anything else has no source (the caller refuses it before reaching here).
 * Header schemes mirror `connection-service.ts`'s `probeFor` exactly.
 */
export function jiraProjectSource(kind: ConnectionKind): ProjectSource | null {
  switch (kind) {
    case "jira_cloud":
      return {
        // Cloud's searchable project endpoint; one page, ordered by key.
        path: "/rest/api/3/project/search?maxResults=100&orderBy=key",
        header: (token, email) => ({ authorization: basic(email, token) }),
        // Cloud wraps the page in `{ values: [...] }`.
        parse: (body) => readProjects((body as { values?: unknown } | null)?.values),
      };
    case "jira_dc":
      return {
        // Data Center returns every visible project as a bare array.
        path: "/rest/api/2/project",
        header: (token) => ({ authorization: `Bearer ${token}` }),
        parse: (body) => readProjects(body),
      };
    default:
      return null;
  }
}

/**
 * List the Jira projects reachable by a stored connection, using its stored
 * token.
 *
 * `token` is resolved by the caller from the connection's `secretRef` (never
 * passed in from a request). The account email Cloud's Basic auth needs is read
 * from the connection's stored `config.email`, the same place the live test
 * reads it. A connection whose kind cannot list, or that has no token, or that
 * the provider rejects, yields a secret-free `ok:false`.
 */
export async function listJiraProjects(
  connection: ConnectionRecord,
  token: string | null,
  fetchImpl: ConnectorFetch,
): Promise<JiraProjectsResult> {
  const source = jiraProjectSource(connection.kind);
  if (source === null) {
    return {
      ok: false,
      messageKey: "onboard.jira.not_listable",
      messageParams: { kind: connection.kind },
    };
  }
  if (token === null) {
    return { ok: false, messageKey: "onboard.jira.no_token" };
  }

  const email = str((connection.config as { email?: unknown } | null)?.email) ?? "";
  const url = `${connection.baseUrl.replace(/\/+$/, "")}${source.path}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json", ...source.header(token, email) },
    });
  } catch {
    // Dropped whole: a fetch error can embed the URL and, on some runtimes, the
    // request headers — where the token is.
    return { ok: false, messageKey: "onboard.jira.unreachable" };
  }

  if (response.status < 200 || response.status >= 300) {
    return {
      ok: false,
      messageKey: "onboard.jira.http_error",
      messageParams: { status: String(response.status) },
    };
  }

  try {
    return { ok: true, projects: source.parse(await response.json()) };
  } catch {
    return { ok: false, messageKey: "onboard.jira.bad_response" };
  }
}
