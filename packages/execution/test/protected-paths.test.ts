import { describe, expect, it } from "vitest";
import { ExecutionConfigError } from "../src/errors.js";
import {
  compileProtectedPath,
  createProtectedPathMatcher,
  DEFAULT_PROTECTED_PATHS,
  findProtectedViolations,
  normalizeRepoPath,
} from "../src/protected-paths.js";
import { changed } from "./helpers.js";

describe("compileProtectedPath", () => {
  const cases: Array<[string, string, boolean]> = [
    ["**/migrations/**", "db/migrations/001.sql", true],
    ["**/migrations/**", "migrations/001.sql", true],
    ["**/migrations/**", "src/migrationsx/a.ts", false],
    ["db/*.sql", "db/a.sql", true],
    ["db/*.sql", "db/sub/a.sql", false],
    ["**/*.pem", "certs/deep/key.pem", true],
    [".maestro.yaml", ".maestro.yaml", true],
    [".maestro.yaml", "sub/.maestro.yaml", false],
    ["src/a?.ts", "src/ab.ts", true],
    ["src/a?.ts", "src/abc.ts", false],
  ];
  for (const [pattern, path, expected] of cases) {
    it(`${pattern} ${expected ? "matches" : "does not match"} ${path}`, () => {
      expect(compileProtectedPath(pattern).test(path)).toBe(expected);
    });
  }

  it("treats a dot as a literal, not as 'any character'", () => {
    expect(compileProtectedPath("**/.env").test("xenv")).toBe(false);
    expect(compileProtectedPath("**/.env").test("app/.env")).toBe(true);
  });

  it("refuses patterns it cannot honour rather than matching nothing", () => {
    expect(() => compileProtectedPath("")).toThrow(ExecutionConfigError);
    expect(() => compileProtectedPath("/etc/passwd")).toThrow(/repo-relative/);
    expect(() => compileProtectedPath("C:/secrets")).toThrow(/repo-relative/);
    expect(() => compileProtectedPath("db\\migrations")).toThrow(/forward slashes/);
  });
});

// Y2 — the compiler used to escape what it did not understand, producing a
// pattern that matched nothing while reading in review as protection.
describe("compileProtectedPath — unsupported syntax is refused, never neutered", () => {
  const unsupported = [
    "**/*.{sql,ddl}",
    "**/[Ss]ecrets/**",
    "+(migrations|secrets)/**",
    "!(vendor)/**",
    "db/**/*.sq|",
    "secrets/**$",
  ];
  for (const pattern of unsupported) {
    it(`rejects ${pattern} at load time`, () => {
      expect(() => compileProtectedPath(pattern)).toThrow(ExecutionConfigError);
    });
  }

  it("names the offending character so the operator can fix the file", () => {
    expect(() => compileProtectedPath("**/*.{sql,ddl}")).toThrow(/unsupported syntax/);
  });

  it("is the reason a brace pattern can no longer silently pass a .sql file", () => {
    // The old compiler turned this into a search for a literal "{sql,ddl}".
    let compiled: RegExp | null = null;
    try {
      compiled = compileProtectedPath("**/*.{sql,ddl}");
    } catch {
      compiled = null;
    }
    expect(compiled).toBeNull();
  });
});

// O7 — a deny-list may over-match safely; under-matching is the failure.
describe("compileProtectedPath — case and unicode cannot be used to walk past it", () => {
  const matcher = createProtectedPathMatcher();
  const dodges = ["db/Migrations/001.SQL", "api/.ENV", "tls/server.KEY", ".Maestro.yaml", "APP/Secrets/a.txt"];
  for (const path of dodges) {
    it(`still catches ${path}`, () => {
      expect(matcher.match(path)).not.toBeNull();
    });
  }

  it("matches a decomposed (NFD) path against a composed pattern", () => {
    const composed = "gizli/ş/.env".normalize("NFC");
    const decomposed = "gizli/ş/.env".normalize("NFD");
    expect(decomposed).not.toBe(composed);
    expect(createProtectedPathMatcher(["gizli/**"]).match(decomposed)).not.toBeNull();
  });
});

describe("normalizeRepoPath", () => {
  it("normalises the shapes a probe may produce", () => {
    expect(normalizeRepoPath("./src/a.ts")).toBe("src/a.ts");
    expect(normalizeRepoPath("src\\a.ts")).toBe("src/a.ts");
  });

  it("rejects a change that is not inside the workspace", () => {
    expect(() => normalizeRepoPath("/etc/passwd")).toThrow(/absolute/);
    expect(() => normalizeRepoPath("../../etc/passwd")).toThrow(/escapes the workspace/);
    expect(() => normalizeRepoPath("  ")).toThrow(ExecutionConfigError);
  });
});

describe("findProtectedViolations", () => {
  const matcher = createProtectedPathMatcher();

  it("passes an ordinary change", () => {
    expect(findProtectedViolations([changed("src/pay/mapper.ts")], matcher)).toEqual([]);
  });

  it("names the file and the rule that caught it", () => {
    const violations = findProtectedViolations(
      [changed("src/a.ts"), changed("db/migrations/002.sql", { status: "added" })],
      matcher,
    );
    expect(violations).toEqual([
      { path: "db/migrations/002.sql", pattern: "**/migrations/**", status: "added" },
    ]);
  });

  it("catches a deletion, not only an edit", () => {
    const violations = findProtectedViolations([changed("app/secrets/keys.json", { status: "deleted" })], matcher);
    expect(violations[0]?.status).toBe("deleted");
  });
});

// O6 — a rename is one git entry with two paths, and only one of them is
// `path`. A typechange is a regular file becoming a symlink.
describe("findProtectedViolations — renames and type changes", () => {
  const matcher = createProtectedPathMatcher();

  it("catches a file renamed ONTO protected ground", () => {
    const violations = findProtectedViolations(
      [changed("app/secrets/stolen.txt", { status: "renamed", fromPath: "src/util.ts" })],
      matcher,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe("app/secrets/stolen.txt");
  });

  it("catches a file renamed OFF protected ground, which the destination alone hides", () => {
    const violations = findProtectedViolations(
      [changed("public/downloads/notes.txt", { status: "renamed", fromPath: "tls/server.key" })],
      matcher,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe("tls/server.key");
    expect(violations[0]?.status).toBe("renamed");
  });

  it("reports a typechange as itself, not as an ordinary modification", () => {
    const violations = findProtectedViolations([changed(".env", { status: "typechange" })], matcher);
    expect(violations[0]?.status).toBe("typechange");
  });
});

// Y3/O8 — the floor cannot be switched off, and it covers the runner's own
// execution surface.
describe("createProtectedPathMatcher — the defaults are a floor, not a suggestion", () => {
  it("protects migrations and secrets out of the box (M52 defaults)", () => {
    const matcher = createProtectedPathMatcher(DEFAULT_PROTECTED_PATHS);
    for (const path of ["db/migrations/1.sql", "app/secrets/a.txt", ".env", "svc/.env.prod", "tls/server.key"]) {
      expect(matcher.match(path)).not.toBeNull();
    }
  });

  it("still applies them when the repo configured an EMPTY list", () => {
    const matcher = createProtectedPathMatcher([]);
    for (const path of ["db/migrations/1.sql", "api/.env", "tls/server.key"]) {
      expect(matcher.match(path)).not.toBeNull();
    }
  });

  it("unions the repo's list with the floor instead of replacing it", () => {
    const matcher = createProtectedPathMatcher(["docs/**"]);
    expect(matcher.match("docs/a.md")).toBe("docs/**");
    expect(matcher.match("api/.env")).toBe("**/.env");
  });

  it("covers the runner's own execution surface — git hooks, CI, agent config", () => {
    const matcher = createProtectedPathMatcher();
    for (const path of [
      ".git/hooks/post-checkout",
      ".git/config",
      ".github/workflows/ci.yml",
      ".claude/settings.json",
      "sub/.claude/settings.local.json",
      "Jenkinsfile",
      ".gitlab-ci.yml",
    ]) {
      expect(matcher.match(path)).not.toBeNull();
    }
  });

  // M53 draws the line at the human gate, not mid-session: a dependency
  // outside the approved list needs Tech Lead approval, which means the change
  // is FLAGGED on the PR. Blocking lockfiles here would make every routine
  // version bump impossible for the agent (orchestrator decision).
  it("leaves lockfiles writable — M53 flags them, it does not refuse them", () => {
    const matcher = createProtectedPathMatcher();
    for (const path of ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "go.sum", "Cargo.lock"]) {
      expect(matcher.match(path)).toBeNull();
    }
  });

  it("rejects a matcher built from an unusable pattern at construction time", () => {
    expect(() => createProtectedPathMatcher(["/abs"])).toThrow(ExecutionConfigError);
    expect(() => createProtectedPathMatcher(["**/*.{sql,ddl}"])).toThrow(ExecutionConfigError);
  });

  it("does not report a duplicate pattern twice", () => {
    const matcher = createProtectedPathMatcher(["**/.env", "**/.env"]);
    expect(matcher.patterns.filter((p) => p === "**/.env")).toHaveLength(1);
  });
});
