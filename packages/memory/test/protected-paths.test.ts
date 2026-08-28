import { describe, expect, it } from "vitest";
import {
  compileProtectedPaths,
  DEFAULT_PROTECTED_PATHS,
  normalisePath,
  protectedPathHits,
} from "../src/protected-paths.js";

describe("normalisePath", () => {
  it("collapses the spellings of a repo-relative path", () => {
    expect(normalisePath("./src/a.ts")).toBe("src/a.ts");
    expect(normalisePath("/src/a.ts")).toBe("src/a.ts");
    expect(normalisePath("src\\a.ts")).toBe("src/a.ts");
    expect(normalisePath("  src/a.ts  ")).toBe("src/a.ts");
  });
});

describe("compileProtectedPaths", () => {
  it("treats a wildcard-free pattern as the whole subtree", () => {
    const compiled = compileProtectedPaths(["db/migrations"]);
    expect(compiled.match("db/migrations")).toBe("db/migrations");
    expect(compiled.match("db/migrations/0001.sql")).toBe("db/migrations");
    expect(compiled.match("db/migrations-old/0001.sql")).toBeUndefined();
  });

  it("lets `**` cross directories and `*` stay inside one", () => {
    const compiled = compileProtectedPaths(["**/migrations/**", "src/*.env"]);
    expect(compiled.match("apps/api/db/migrations/0001.sql")).toBe("**/migrations/**");
    expect(compiled.match("migrations/0001.sql")).toBe("**/migrations/**");
    expect(compiled.match("src/prod.env")).toBe("src/*.env");
    expect(compiled.match("src/deep/prod.env")).toBeUndefined();
  });

  it("supports directory patterns and single-character wildcards", () => {
    const compiled = compileProtectedPaths(["infra/", "conf/app?.yaml"]);
    expect(compiled.match("infra/main.tf")).toBe("infra/");
    expect(compiled.match("infra")).toBeUndefined();
    expect(compiled.match("conf/app1.yaml")).toBe("conf/app?.yaml");
    expect(compiled.match("conf/app12.yaml")).toBeUndefined();
  });

  it("escapes regex metacharacters instead of interpreting them", () => {
    const compiled = compileProtectedPaths(["src/a+b(c)/file.ts"]);
    expect(compiled.match("src/a+b(c)/file.ts")).toBe("src/a+b(c)/file.ts");
    expect(compiled.match("src/aab_c_/file.ts")).toBeUndefined();
  });

  it("drops empty patterns rather than matching everything", () => {
    const compiled = compileProtectedPaths(["", "   ", "src"]);
    expect(compiled.patterns).toEqual(["src"]);
    expect(compiled.match("anything/else.ts")).toBeUndefined();
  });

  it("covers migrations and secret material out of the box (M52)", () => {
    const compiled = compileProtectedPaths(DEFAULT_PROTECTED_PATHS);
    expect(compiled.match("db/migrations/0001.sql")).toBeDefined();
    expect(compiled.match("apps/api/.env.production")).toBeDefined();
    expect(compiled.match("infra/certs/server.pem")).toBeDefined();
    expect(compiled.match("src/pay/service.ts")).toBeUndefined();
  });
});

describe("protectedPathHits", () => {
  it("reports every offending file with the pattern that claimed it", () => {
    const hits = protectedPathHits(
      ["src/a.ts", "db/migrations/0001.sql", "keys/prod.pem"],
      ["db/migrations/**", "**/*.pem"],
    );
    expect(hits).toEqual([
      { file: "db/migrations/0001.sql", pattern: "db/migrations/**" },
      { file: "keys/prod.pem", pattern: "**/*.pem" },
    ]);
  });

  it("is empty when a diff is clean", () => {
    expect(protectedPathHits(["src/a.ts"], ["db/migrations/**"])).toEqual([]);
  });
});
