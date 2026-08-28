import { normalizeProjectStatuses, normalizeProjectIssueTypes } from "@maestro/adapter-jira";
import type { ConnectionKind } from "@maestro/contracts";
import type { ConnectionRecord } from "./connection-store.js";
import type { ConnectorFetch } from "./connection-service.js";

/**
 * The values a listening rule can match on for a project — the project's real
 * STATUS names or ISSUE-TYPE names, read LIVE off Jira with the connection's
 * stored token. This turns the rule form's "Değer" field from free text (where
 * "hata" vs "Hata" silently matches nothing) into a dropdown of exactly the
 * names Jira will present, so a mistyped value is impossible.
 *
 * STATUSES come from `GET /project/{key}/statuses` — the same endpoint the M102
 * workflow-import screen uses. It groups statuses by issue type, so the nested
 * names are the statuses, and those ARE the names on the issues (verified live
 * against project OPS: `İNCELEMEDE / Yapılacaklar / Tamam / Devam Ediyor` are
 * exactly what `fields.status.name` carries). That branch is load-bearing for
 * the status-map feature and is left alone.
 *
 * ISSUE TYPES do NOT come from that payload, and this is the trap. Its
 * top-level `name` per group is the issue type in a DIFFERENT LOCALISATION from
 * the issue resource — Jira renders that endpoint's type names in the site's
 * default/English locale while `/issue/{key}` returns the project's translated
 * ones. Measured live on OPS:
 *
 *   /rest/api/3/project/OPS/statuses            -> Epic, Subtask, Task,  Story,  Feature, Bug
 *   /rest/api/3/issue/createmeta/OPS/issuetypes -> Epik, Subtask, Görev, Hikaye, Feature, Hata
 *   issue OPS-66 fields.issuetype.name          -> Görev
 *
 * `flow-decision.ts` compares `rule.matchValue` to the ticket's `issueType`,
 * which is `fields.issuetype.name` verbatim. So a rule built from the statuses
 * payload says `Task` and matches NOTHING, silently, forever. Issue types are
 * therefore read from `createmeta/{key}/issuetypes`, whose names agree with the
 * issue resource. One extra call, and only for `kind=issuetype`.
 */

export type MatchValueKind = "status" | "issuetype";

export type MatchValuesResult =
  | {
      ok: true;
      values: readonly string[];
      /**
       * Set when the issue-type list came from the FALLBACK source, so the
       * names may be the wrong localisation (see the module comment). The
       * dropdown is still offered — a stale list an operator can eyeball beats
       * an empty one with no explanation — but the caller can say so.
       */
      degraded?: true;
      degradedKey?: string;
    }
  | { ok: false; messageKey: string; messageParams?: Record<string, string> };

interface Source {
  /** `/project/{key}/statuses`, per Jira flavour. */
  path(projectKey: string): string;
  /**
   * `/issue/createmeta/{key}/issuetypes`, per Jira flavour — the only source
   * whose issue-type names match the ones on issues. `null` where we have not
   * verified the endpoint exists, and that flavour keeps `path` for both kinds.
   */
  issueTypePath?(projectKey: string): string;
  header(token: string, email: string): Record<string, string>;
}

function basic(user: string, token: string): string {
  return `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;
}

/** Header schemes mirror `connection-service.ts`'s `probeFor` exactly. */
export function jiraMatchSource(kind: ConnectionKind): Source | null {
  switch (kind) {
    case "jira_cloud":
      return {
        path: (key) => `/rest/api/3/project/${encodeURIComponent(key)}/statuses`,
        issueTypePath: (key) => `/rest/api/3/issue/createmeta/${encodeURIComponent(key)}/issuetypes`,
        header: (token, email) => ({ authorization: basic(email, token) }),
      };
    case "jira_dc":
      // No `issueTypePath` ON PURPOSE. Server/DC documents the same
      // `/rest/api/2/issue/createmeta/{key}/issuetypes`, but we have no DC
      // instance to measure it against — and on older DC builds it 404s. Since
      // DC's localisation trap is unproven while breaking the working list is
      // certain, DC stays on `/project/{key}/statuses` for both kinds until
      // someone can verify a real deployment. Fix Cloud; do not guess at DC.
      return {
        path: (key) => `/rest/api/2/project/${encodeURIComponent(key)}/statuses`,
        header: (token) => ({ authorization: `Bearer ${token}` }),
      };
    default:
      return null;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Issue-type NAMES out of a createmeta issuetypes body.
 *
 * The array has lived under two keys across Jira versions — `issueTypes` on
 * current Cloud, `values` on the paginated shape — so both are accepted rather
 * than pinning to whichever one this site happens to serve today. Anything else
 * is `null`, which the caller reads as "this source did not answer" and
 * degrades on, not as "this project has no issue types".
 */
export function parseCreateMetaIssueTypes(raw: unknown): string[] | null {
  const body = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
  if (body === null) return null;
  const list = Array.isArray(body["issueTypes"])
    ? body["issueTypes"]
    : Array.isArray(body["values"])
      ? body["values"]
      : null;
  if (list === null) return null;

  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of list) {
    const name = str((typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {})["name"]);
    const trimmed = name?.trim();
    // Subtask types are KEPT — a rule may legitimately target one, same call
    // the adapter's `normalizeProjectIssueTypes` makes.
    if (trimmed !== undefined && trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  // An empty-but-well-formed page is still an answer we refuse to trust over
  // the fallback: a project always has at least one creatable issue type, so
  // zero here means the caller lacks create permission, not that none exist.
  return out.length > 0 ? out : null;
}

/** One GET with the flavour's auth; `null` on anything that is not a 2xx body. */
async function readJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl: ConnectorFetch,
): Promise<{ ok: true; body: unknown } | { ok: false; reason: "unreachable" | "http" | "body"; status?: number }> {
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "GET", headers: { accept: "application/json", ...headers } });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, reason: "http", status: response.status };
  }
  try {
    return { ok: true, body: await response.json() };
  } catch {
    return { ok: false, reason: "body" };
  }
}

/**
 * List a project's status names or issue-type names via a stored connection.
 * `token` is resolved by the caller from `secretRef` (never passed in plain from
 * a client). Failures are secret-free catalog keys, never prose that could carry
 * the URL/token.
 */
export async function listJiraMatchValues(
  connection: ConnectionRecord,
  projectKey: string,
  kind: MatchValueKind,
  token: string | null,
  fetchImpl: ConnectorFetch,
): Promise<MatchValuesResult> {
  const source = jiraMatchSource(connection.kind);
  if (source === null) {
    return { ok: false, messageKey: "onboard.jira.not_listable", messageParams: { kind: connection.kind } };
  }
  if (token === null) return { ok: false, messageKey: "onboard.jira.no_token" };
  if (projectKey.trim().length === 0) return { ok: false, messageKey: "onboard.jira.bad_response" };

  const email = str((connection.config as { email?: unknown } | null)?.email) ?? "";
  const base = connection.baseUrl.replace(/\/+$/, "");
  const key = projectKey.trim();
  const headers = source.header(token, email);

  // ── issue types: the createmeta source first, the statuses payload as a net ──
  if (kind === "issuetype" && source.issueTypePath !== undefined) {
    const meta = await readJson(`${base}${source.issueTypePath(key)}`, headers, fetchImpl);
    if (meta.ok) {
      const names = parseCreateMetaIssueTypes(meta.body);
      if (names !== null) return { ok: true, values: names };
    }
    // createmeta is missing (older deployment), forbidden (no create permission
    // in this project), or shaped in a way we do not recognise. Fall through to
    // the statuses payload rather than handing back an empty dropdown: the
    // names may be the wrong localisation, but a list an operator can read and
    // correct beats a blank box that explains nothing. `degraded` says so out
    // loud so the screen and anyone reading the response can tell which it is.
    const fallback = await readJson(`${base}${source.path(key)}`, headers, fetchImpl);
    if (!fallback.ok) return failure(fallback);
    try {
      const names = normalizeProjectIssueTypes(fallback.body);
      if (names.length === 0) return { ok: false, messageKey: "onboard.jira.bad_response" };
      return {
        ok: true,
        values: [...new Set(names)],
        degraded: true,
        degradedKey: "onboard.jira.issuetypes_degraded",
      };
    } catch {
      return { ok: false, messageKey: "onboard.jira.bad_response" };
    }
  }

  // ── statuses (and DC's issue types) off /project/{key}/statuses, unchanged ──
  const read = await readJson(`${base}${source.path(key)}`, headers, fetchImpl);
  if (!read.ok) return failure(read);
  try {
    const values =
      kind === "status"
        ? normalizeProjectStatuses(read.body).map((s) => s.name)
        : normalizeProjectIssueTypes(read.body);
    // De-duplicate status names (the endpoint repeats a status per issue type).
    return { ok: true, values: [...new Set(values)] };
  } catch {
    return { ok: false, messageKey: "onboard.jira.bad_response" };
  }
}

/** A failed read as the same secret-free catalog keys this module always spoke. */
function failure(read: { reason: "unreachable" | "http" | "body"; status?: number }): MatchValuesResult {
  if (read.reason === "unreachable") return { ok: false, messageKey: "onboard.jira.unreachable" };
  if (read.reason === "http") {
    return { ok: false, messageKey: "onboard.jira.http_error", messageParams: { status: String(read.status ?? 0) } };
  }
  return { ok: false, messageKey: "onboard.jira.bad_response" };
}
