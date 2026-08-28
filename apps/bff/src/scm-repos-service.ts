import type { ConnectionKind } from "@maestro/contracts";
import type { ConnectionRecord } from "./connection-store.js";
import type { ConnectorFetch } from "./connection-service.js";

/**
 * Listing the repositories a stored SCM connection can reach (onboarding).
 *
 * The sibling of `connection-service.ts`'s live TEST: same discipline — the URL
 * is built from the connection's STORED `baseUrl`, the STORED token is presented
 * with the kind's header, and nothing the caller sent reaches the request. A
 * viewer cannot turn this into an SSRF or an exfiltration channel, and a failure
 * is reported as a secret-free catalog key, never a stack trace that could carry
 * the token in a URL or a header.
 *
 * This lives OUTSIDE the frozen `ScmPort`: that port resolves a KNOWN repo for
 * the workflow engine; listing an org's repos for the onboarding wizard is a new
 * read the port does not model, so it is a BFF service over the connector layer
 * rather than a port change (same reasoning that put the Jira-workflow reader
 * outside contracts).
 */

/** One repository as the wizard needs it: a stable id and a human full name. */
export interface ScmRepo {
  /** Provider id (GitHub node/number as string, ADO guid) — stable per repo. */
  readonly id: string;
  /** "owner/repo" (GitHub) or "project/repo" (ADO) — what the operator picks. */
  readonly fullName: string;
}

/** The outcome of a repo listing: the repos, or a secret-free failure key. */
export type ScmReposResult =
  | { readonly ok: true; readonly repos: readonly ScmRepo[] }
  | { readonly ok: false; readonly messageKey: string; readonly messageParams?: Record<string, string> };

/** How to list repos for one connection kind: a path + header + a body reader. */
interface RepoSource {
  path: string;
  header(token: string): Record<string, string>;
  parse(body: unknown): readonly ScmRepo[];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The repo source per SCM kind. Only `github` and `ado` list; anything else has
 * no source (the caller refuses it before reaching here). Header schemes mirror
 * `connection-service.ts`'s `probeFor` exactly — GitHub bearer, ADO Basic with an
 * empty username.
 */
export function scmRepoSource(kind: ConnectionKind): RepoSource | null {
  switch (kind) {
    case "github":
      return {
        // Owner + collaborator + org repos, most-recently-updated first, one page.
        path: "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
        header: (token) => ({ authorization: `Bearer ${token}`, "user-agent": "maestro" }),
        parse: (body) => {
          if (!Array.isArray(body)) return [];
          return body.flatMap((entry): ScmRepo[] => {
            if (typeof entry !== "object" || entry === null) return [];
            const record = entry as Record<string, unknown>;
            const fullName = str(record["full_name"]);
            const id = record["id"];
            if (fullName === undefined || id === undefined) return [];
            return [{ id: String(id), fullName }];
          });
        },
      };
    case "ado":
      return {
        path: "/_apis/git/repositories?api-version=7.1",
        header: (token) => ({ authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}` }),
        parse: (body) => {
          // ADO wraps the list in `{ value: [...] }`; each repo carries a
          // `project.name` and its own `name`, joined as "project/repo".
          const value = (body as { value?: unknown } | null)?.value;
          if (!Array.isArray(value)) return [];
          return value.flatMap((entry): ScmRepo[] => {
            if (typeof entry !== "object" || entry === null) return [];
            const record = entry as Record<string, unknown>;
            const id = record["id"];
            const name = str(record["name"]);
            const project = str((record["project"] as { name?: unknown } | undefined)?.name as string);
            if (id === undefined || name === undefined) return [];
            const fullName = project === undefined ? name : `${project}/${name}`;
            return [{ id: String(id), fullName }];
          });
        },
      };
    default:
      return null;
  }
}

/**
 * List the repositories reachable by a stored connection, using its stored token.
 *
 * `token` is resolved by the caller from the connection's `secretRef` (never
 * passed in from a request). A connection whose kind cannot list, or that has no
 * token, or that the provider rejects, yields a secret-free `ok:false` — the
 * wizard shows a clear state rather than a broken dropdown.
 */
export async function listScmRepos(
  connection: ConnectionRecord,
  token: string | null,
  fetchImpl: ConnectorFetch,
): Promise<ScmReposResult> {
  const source = scmRepoSource(connection.kind);
  if (source === null) {
    return { ok: false, messageKey: "onboard.scm.not_listable", messageParams: { kind: connection.kind } };
  }
  if (token === null) {
    return { ok: false, messageKey: "onboard.scm.no_token" };
  }

  const url = `${connection.baseUrl.replace(/\/+$/, "")}${source.path}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json", ...source.header(token) },
    });
  } catch {
    // The message is dropped whole: a fetch error can embed the URL and, on some
    // runtimes, the request headers — where the token is.
    return { ok: false, messageKey: "onboard.scm.unreachable" };
  }

  if (response.status < 200 || response.status >= 300) {
    return {
      ok: false,
      messageKey: "onboard.scm.http_error",
      messageParams: { status: String(response.status) },
    };
  }

  try {
    return { ok: true, repos: source.parse(await response.json()) };
  } catch {
    return { ok: false, messageKey: "onboard.scm.bad_response" };
  }
}
