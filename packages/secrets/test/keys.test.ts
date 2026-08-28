import { describe, expect, it } from "vitest";
import { DEFAULT_FIELD, envVarName, parseScope, parseSecretKey, SecretKeyError } from "../src/index.js";
import { adoNames } from "./helpers.js";

describe("secret key grammar", () => {
  it("splits <mount>/<path>#<field>", () => {
    expect(parseSecretKey("kv/jira/pat#token")).toEqual({ mount: "kv", path: "jira/pat", field: "token" });
  });

  it("falls back to the default field", () => {
    expect(parseSecretKey("kv/jira/pat")).toEqual({ mount: "kv", path: "jira/pat", field: DEFAULT_FIELD });
  });

  it("trims surrounding whitespace", () => {
    expect(parseSecretKey("  kv/jira/pat  ").path).toBe("jira/pat");
  });

  it.each([
    ["", "empty key"],
    ["jira", "no mount separator"],
    ["kv/", "empty trailing segment"],
    ["/jira/pat", "empty mount"],
    ["kv/../../etc/passwd", "path traversal"],
    ["kv/jira/pat#", "empty field"],
    ["kv/jira/pat#a#b", "two field separators"],
    ["kv/jira pat", "space in a segment"],
    ["kv/jira/pat#../x", "traversal in the field"],
  ])("rejects %j (%s)", (key) => {
    expect(() => parseSecretKey(key)).toThrow(SecretKeyError);
  });

  it("rejects a scope that tries to escape its prefix", () => {
    expect(() => parseScope("../../auth/token/root")).toThrow(SecretKeyError);
    expect(() => parseScope("repo/x#field")).toThrow(SecretKeyError);
    expect(() => parseScope("")).toThrow(SecretKeyError);
  });

  it("accepts a well-formed scope unchanged", () => {
    expect(parseScope(" repo/ugurpay-core/push ")).toBe("repo/ugurpay-core/push");
  });

  it("maps a key to a stable environment variable name", () => {
    const key = parseSecretKey("kv/jira/pat#token");
    expect(envVarName(key, "MAESTRO_SECRET_")).toBe("MAESTRO_SECRET_KV_JIRA_PAT__TOKEN");
    expect(envVarName(parseSecretKey("kv/jira/pat"), "MAESTRO_SECRET_")).toBe("MAESTRO_SECRET_KV_JIRA_PAT__VALUE");
  });

  it("keeps distinct keys on distinct variable names", () => {
    const a = envVarName(parseSecretKey("kv/a/b#c"), "P_");
    const b = envVarName(parseSecretKey("kv/a/b#d"), "P_");
    expect(a).not.toBe(b);
  });
});

/**
 * The env-file mapping must be INJECTIVE: two different keys that land on the
 * same variable name mean the driver silently hands out the wrong secret, which
 * no error path can catch afterwards.
 */
describe("envVarName is injective", () => {
  const CORPUS = [
    "kv/jira/pat",
    "kv/jira/pat#token",
    "kv/jira-prod/pat",
    "kv/jira/prod/pat",
    "kv/jira.prod/pat",
    "kv/jira_prod/pat",
    "kv/Jira/pat",
    "kv/JIRA/pat",
    "kv/jira/pat#a-b",
    "kv/jira/pat#a.b",
    "kv/jira/pat#a_b",
    "kv/jira/pat#A",
    "kv/jira/pat-token",
    "kv/jira/pat#pat_token",
    "kv/a/b-c/d",
    "kv/a/b/c-d",
    "kv/a-b/c/d",
    "kv/a/b_c#d",
    "kv/a/b#c_d",
    "git/creds/x",
    "git/creds-x",
  ] as const;

  it("gives every key in the corpus its own variable name", () => {
    const names = CORPUS.map((key) => envVarName(parseSecretKey(key), "MAESTRO_SECRET_"));

    expect(new Set(names).size).toBe(CORPUS.length);
  });

  it.each([
    ["kv/jira-prod/pat", "kv/jira/prod/pat"],
    ["kv/jira.prod/pat", "kv/jira/prod/pat"],
    ["kv/jira_prod/pat", "kv/jira/prod/pat"],
    ["kv/Jira/pat", "kv/jira/pat"],
  ])("separates %j from %j", (left, right) => {
    expect(envVarName(parseSecretKey(left), "P_")).not.toBe(envVarName(parseSecretKey(right), "P_"));
  });

  it("keeps every generated name a legal POSIX environment variable name", () => {
    for (const key of CORPUS) {
      expect(envVarName(parseSecretKey(key), "MAESTRO_SECRET_")).toMatch(/^[A-Z_][A-Z0-9_]*$/);
    }
  });
});

/**
 * Scope grammar (M31): `adapter-ado` builds "ado/<project>/<repo>/push" from
 * RepoRef, whose project/repo are NonEmpty in the frozen contracts — spaces,
 * dots, underscores and non-ASCII are all real ADO names. Rejecting them means
 * no push credential can ever be issued for those projects.
 */
describe("parseScope accepts real Azure DevOps names", () => {
  const { projects, repos } = adoNames();
  const scopes = [
    ...projects.map((project, i) => `ado/${project}/${repos[i % repos.length]}/push`),
    ...repos.map((repo) => `ado/${projects[0]}/${repo}/push`),
  ];

  it.each(scopes)("accepts %j", (scope) => {
    expect(parseScope(scope)).toBe(scope);
  });

  it("trims the scope as a whole but keeps inner spaces", () => {
    expect(parseScope("  ado/Core Banking/core-api/push ")).toBe("ado/Core Banking/core-api/push");
  });
});

describe("parseScope still refuses unsafe scopes", () => {
  it.each([
    ["..", "bare parent"],
    ["../..", "parent chain"],
    ["ado/../../auth/token/create", "traversal in the middle"],
    ["ado/./x/push", "current-dir element"],
    ["/ado/x/push", "empty leading segment"],
    ["ado/x/push/", "empty trailing segment"],
    ["ado//x/push", "empty inner segment"],
    ["", "empty scope"],
    ["   ", "whitespace only"],
    ["ado/ x/push", "leading space in a segment"],
    ["ado/x /push", "trailing space in a segment"],
    ["ado/..\\..\\x/push", "backslash traversal (WHATWG URL folds \\ into /)"],
    ["ado/x\\y/push", "backslash"],
    ["ado/%2e%2e/push", "percent-encoded traversal"],
    ["ado/%2f/push", "percent-encoded separator"],
    ["ado/x?ttl=99999/push", "query injection"],
    ["ado/x#field/push", "field suffix"],
    ["ado/x\u0000y/push", "NUL"],
    ["ado/x\ny/push", "newline"],
    ["ado/x\u007Fy/push", "DEL"],
    ["ado/x\u0085y/push", "C1 control"],
  ])("rejects %j (%s)", (scope) => {
    expect(() => parseScope(scope)).toThrow(SecretKeyError);
  });
});
