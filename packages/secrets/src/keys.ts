import { SecretKeyError } from "./errors.js";

/**
 * Secret key grammar, shared by EVERY driver so a reference written in DB
 * config resolves identically whatever driver is wired (M80):
 *
 *     <mount>/<path>[#<field>]        e.g. "kv/jira/pat#token", "kv/jira/pat"
 *
 * The first segment is the KV mount, the rest is the path inside it, and the
 * optional `#field` selects a key of the secret object (default: `value`).
 */
export interface SecretKey {
  mount: string;
  path: string;
  field: string;
}

export const DEFAULT_FIELD = "value";

/** Segments may not be empty, `.` or `..` — that is how path traversal starts. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FIELD = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parseSecretKey(key: string): SecretKey {
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new SecretKeyError(String(key), "key is empty");
  }
  const trimmed = key.trim();

  const hashes = trimmed.split("#");
  if (hashes.length > 2) throw new SecretKeyError(trimmed, "at most one '#field' suffix is allowed");
  const [rawPath, rawField] = hashes as [string, string | undefined];

  const field = rawField === undefined ? DEFAULT_FIELD : rawField;
  if (!FIELD.test(field)) throw new SecretKeyError(trimmed, `field "${field}" is not a bare identifier`);

  const segments = rawPath.split("/");
  if (segments.length < 2) throw new SecretKeyError(trimmed, "expected <mount>/<path>[#<field>]");
  for (const segment of segments) {
    if (!SEGMENT.test(segment) || segment === "." || segment === "..") {
      throw new SecretKeyError(trimmed, `path segment "${segment}" is empty or unsafe`);
    }
  }

  const [mount, ...rest] = segments as [string, ...string[]];
  return { mount, path: rest.join("/"), field };
}

/** A scope may not be longer than this — it ends up in a Vault URL path. */
const MAX_SCOPE_LENGTH = 512;

/**
 * Characters a scope segment may never contain, whatever the upstream system
 * calls its projects:
 *  - C0/C1 controls and DEL: log poisoning and header/URL smuggling;
 *  - `\`: the WHATWG URL parser folds backslashes into `/` for http(s), so
 *    "..\\.." is a traversal in disguise;
 *  - `%`: a percent-escape survives `new URL()` untouched and is decoded by
 *    the server, which turns "%2e%2e" back into "..";
 *  - `?` and `#`: they would end the path and start a query/fragment.
 */
const SCOPE_FORBIDDEN_CHARS = new Set(["\\", "%", "?", "#"]);

function hasForbiddenChar(segment: string): boolean {
  for (const char of segment) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
    if (SCOPE_FORBIDDEN_CHARS.has(char)) return true;
  }
  return false;
}

/**
 * Scope of a short-lived credential (M31), e.g. "ado/Core Banking/core-api/push".
 *
 * Unlike a secret KEY (whose segments we choose ourselves) a scope carries
 * REAL upstream names: `adapter-ado` builds it from `RepoRef`, whose project
 * and repo are `NonEmpty` in the frozen contracts, and an Azure DevOps project
 * legitimately contains spaces, dots, underscores and non-ASCII letters. So the
 * rule here is a deny list of what makes a path dangerous, not an allow list of
 * what looks tidy — an over-strict grammar means no push credential can ever be
 * issued for "Core Banking", which is an M31 outage, not a hardening.
 */
export function parseScope(scope: string): string {
  if (typeof scope !== "string" || scope.trim().length === 0) {
    throw new SecretKeyError(String(scope), "scope is empty");
  }
  const trimmed = scope.trim();
  if (trimmed.length > MAX_SCOPE_LENGTH) {
    throw new SecretKeyError(trimmed.slice(0, 64), `scope is longer than ${MAX_SCOPE_LENGTH} characters`);
  }
  if (trimmed.includes("#")) throw new SecretKeyError(trimmed, "scope must not carry a '#field' suffix");
  for (const segment of trimmed.split("/")) {
    const issue = scopeSegmentIssue(segment);
    if (issue) throw new SecretKeyError(trimmed, `scope segment ${JSON.stringify(segment)} ${issue}`);
  }
  return trimmed;
}

function scopeSegmentIssue(segment: string): string | null {
  if (segment.length === 0) return "is empty";
  if (segment !== segment.trim()) return "has leading or trailing whitespace";
  if (segment === "." || segment === "..") return "is a relative path element";
  if (hasForbiddenChar(segment)) return "contains a control, escape or URL-significant character";
  return null;
}

/**
 * Environment variable name a key maps to in the env-file driver:
 * "kv/jira/pat#token" → "MAESTRO_SECRET_KV_JIRA_PAT__TOKEN".
 *
 * The mapping is INJECTIVE — distinct keys always get distinct names. A naive
 * `[^A-Za-z0-9]+ → "_"` collapse makes "kv/jira-prod/pat", "kv/jira/prod/pat"
 * and "kv/jira.prod/pat" the same variable, and then the driver silently serves
 * one team's secret in answer to another team's key: a failure no error path
 * downstream can catch. Everything a POSIX variable name cannot carry (`-`,
 * `.`, `_`, and upper-case letters, which vanish in the required upper-casing)
 * is therefore escaped as `__<HEX>_`, while `/` stays the plain `_` separator.
 * All-lower-case keys — the documented and overwhelmingly common shape — keep
 * exactly the name they had before.
 */
export function envVarName(key: SecretKey, prefix: string): string {
  return `${prefix}${encodeForEnv(`${key.mount}/${key.path}`)}__${encodeForEnv(key.field)}`;
}

function encodeForEnv(text: string): string {
  let out = "";
  for (const char of text) {
    if (char >= "a" && char <= "z") out += char.toUpperCase();
    else if (char >= "0" && char <= "9") out += char;
    else if (char === "/") out += "_";
    else out += `__${char.codePointAt(0)!.toString(16).toUpperCase()}_`;
  }
  return out;
}
