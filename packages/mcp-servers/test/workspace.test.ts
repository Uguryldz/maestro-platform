import { describe, expect, it } from "vitest";
import { ToolPolicyError } from "../src/errors.js";
import { workspaceMcpServer, workspaceProtectedPatterns } from "../src/servers/workspace.js";
import { guardWorkspacePath, workspaceMatcher } from "../src/workspace-path.js";
import { caller, fakeFs, type FsCalls, runtimeFor } from "./helpers.js";

const agent = caller(["read", "operate"]);
const calls = (): FsCalls => ({ writes: [], reads: [] });

describe("workspace-mcp enforces protected_paths at the tool boundary (M52)", () => {
  it("refuses to write a migration — and the driver is never called", async () => {
    const fsCalls = calls();
    const { runtime } = runtimeFor(workspaceMcpServer({ fs: fakeFs(fsCalls) }));

    const result = await runtime.call(
      "write_file",
      { path: "db/migrations/0001_init.sql", content: "drop table odeme;" },
      agent,
    );

    expect(result.status).toBe("denied");
    if (result.status === "denied") {
      expect(result.reason).toBe("policy");
      expect(result.message).toMatch(/protected path/);
    }
    // The point of enforcing here rather than after the session: nothing was
    // written, so there is no illegal change to catch later.
    expect(fsCalls.writes).toEqual([]);
  });

  it("refuses secrets, CI definitions and the runner's own surfaces", async () => {
    const fsCalls = calls();
    const { runtime } = runtimeFor(workspaceMcpServer({ fs: fakeFs(fsCalls) }));

    for (const path of [
      "api/.env",
      "tls/server.key",
      "config/secrets/db.json",
      ".github/workflows/ci.yml",
      ".git/hooks/post-checkout",
      ".maestro.yaml",
    ]) {
      const result = await runtime.call("write_file", { path, content: "x" }, agent);
      expect(result.status, path).toBe("denied");
    }
    expect(fsCalls.writes).toEqual([]);
  });

  it("honours the repo's extra patterns from .maestro.yaml on top of the defaults", async () => {
    const fsCalls = calls();
    const { runtime } = runtimeFor(
      workspaceMcpServer({ fs: fakeFs(fsCalls), protectedPaths: ["src/legacy/**"] }),
    );

    expect((await runtime.call("write_file", { path: "src/legacy/a.ts", content: "x" }, agent)).status).toBe(
      "denied",
    );
    // An empty/short repo list never shrinks the floor.
    expect(workspaceProtectedPatterns({ fs: fakeFs(fsCalls), protectedPaths: [] })).toContain(
      "**/migrations/**",
    );
  });

  it("allows an ordinary write, and reports the normalised path", async () => {
    const fsCalls = calls();
    const { runtime } = runtimeFor(workspaceMcpServer({ fs: fakeFs(fsCalls) }));

    const result = await runtime.call("write_file", { path: "./src/odeme/tutar.ts", content: "ok" }, agent);

    expect(result).toEqual({ status: "ok", value: { path: "src/odeme/tutar.ts", bytes: 2 } });
    expect(fsCalls.writes).toEqual([{ path: "src/odeme/tutar.ts", content: "ok" }]);
  });

  it("refuses to leave the sandbox for reads as well as writes", async () => {
    const fsCalls = calls();
    const { runtime } = runtimeFor(workspaceMcpServer({ fs: fakeFs(fsCalls) }));

    for (const path of ["/etc/shadow", "../../home/ubuntu/.ssh/id_rsa", "C:/Windows/system32/config"]) {
      const read = await runtime.call("read_file", { path }, agent);
      expect(read.status, path).toBe("denied");
      const write = await runtime.call("write_file", { path, content: "x" }, agent);
      expect(write.status, path).toBe("denied");
    }
    expect(fsCalls.reads).toEqual([]);
    expect(fsCalls.writes).toEqual([]);
  });

  it("lets the agent READ a protected file — understanding a schema is not changing it", async () => {
    const fsCalls = calls();
    const { runtime } = runtimeFor(workspaceMcpServer({ fs: fakeFs(fsCalls) }));

    const result = await runtime.call("read_file", { path: "db/migrations/0001_init.sql" }, agent);

    expect(result.status).toBe("ok");
    expect(fsCalls.reads).toEqual(["db/migrations/0001_init.sql"]);
  });
});

describe("guardWorkspacePath", () => {
  const matcher = workspaceMatcher(["docs/frozen/**"]);

  it("separates an escape, a secret and a protected path — three rules, three names", () => {
    expect(() => guardWorkspacePath("t", matcher, "../x", "read")).toThrow(
      expect.objectContaining({ rule: "path_escape" }) as unknown as Error,
    );
    expect(() => guardWorkspacePath("t", matcher, "docs/frozen/a.md", "write")).toThrow(
      expect.objectContaining({ rule: "protected_path" }) as unknown as Error,
    );
    // B6: a secret is its own refusal, on BOTH legs, so an auditor reading the
    // chain can tell "the model tried to change the schema" from "the model
    // tried to read the private key".
    for (const mode of ["read", "write"] as const) {
      expect(() => guardWorkspacePath("t", matcher, "tls/server.key", mode)).toThrow(
        expect.objectContaining({ rule: "secret_path" }) as unknown as Error,
      );
    }
  });

  it("refuses control characters, which truncate a name at the syscall boundary", () => {
    expect(() => guardWorkspacePath("t", matcher, "secrets/key.pem\u0000.txt", "read")).toThrow(
      ToolPolicyError,
    );
  });

  it("normalises before matching, so ./ and backslashes cannot dodge a rule", () => {
    expect(() => guardWorkspacePath("t", matcher, "./db\\migrations\\1.sql", "write")).toThrow(
      ToolPolicyError,
    );
    expect(guardWorkspacePath("t", matcher, "./src/a.ts", "write")).toBe("src/a.ts");
  });
});
