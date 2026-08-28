import { describe, expect, it } from "vitest";
import {
  buildClaudeArgs,
  buildClaudeEnv,
  CONFIG_DIR_ENV,
  OAUTH_TOKEN_ENV,
  PERMISSION_MODES,
  type ClaudeCliOptions,
} from "../src/cli.js";
import { ClaudeConfigError } from "../src/errors.js";
import { OTHER_SESSION_ID, SESSION_ID } from "./helpers.js";

function opts(over: Partial<ClaudeCliOptions> = {}): ClaudeCliOptions {
  return {
    binPath: "/home/svc/.local/bin/claude",
    model: "claude-opus-4",
    tools: ["Read", "Edit", "Bash"],
    mcpServers: [],
    mcpConfigPath: null,
    permissionMode: "acceptEdits",
    ...over,
  };
}

function pairAfter(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

/** Everything between `flag` and the next `--flag`. */
function valuesAfter(args: string[], flag: string): string[] {
  const at = args.indexOf(flag);
  if (at === -1) return [];
  const rest = args.slice(at + 1);
  const end = rest.findIndex((a) => a.startsWith("--"));
  return end === -1 ? rest : rest.slice(0, end);
}

describe("buildClaudeArgs", () => {
  it("runs non-interactively with a machine-readable stream", () => {
    const args = buildClaudeArgs(opts());
    expect(args).toContain("--print");
    expect(pairAfter(args, "--output-format")).toBe("stream-json");
    expect(pairAfter(args, "--input-format")).toBe("text");
    expect(pairAfter(args, "--model")).toBe("claude-opus-4");
    expect(pairAfter(args, "--permission-mode")).toBe("acceptEdits");
  });

  it("always pairs stream-json with --verbose (the CLI refuses it otherwise)", () => {
    const args = buildClaudeArgs(opts());
    expect(args).toContain("--verbose");
    expect(args.indexOf("--verbose")).toBeGreaterThan(args.indexOf("--output-format"));
  });

  it("never uses --bare, which would cut a subscription seat off from its OAuth login", () => {
    expect(buildClaudeArgs(opts())).not.toContain("--bare");
  });

  /**
   * The old version of this asserted that argv did not contain a string the
   * function is never handed, so it could not fail. This one enumerates every
   * non-flag token instead: anything that reaches argv without coming from a
   * declared option — a prompt, a task, an interpolated path — breaks it.
   */
  it("puts nothing in argv that did not come from a declared option", () => {
    const args = buildClaudeArgs(
      opts({ mcpServers: ["jira"], mcpConfigPath: "/etc/mcp.json", settingsPath: "/etc/maestro/claude.json" }),
    );
    const expected = new Set([
      "stream-json",
      "text",
      "claude-opus-4",
      "acceptEdits",
      "user",
      "/etc/maestro/claude.json",
      "Read",
      "Edit",
      "Bash",
      "/etc/mcp.json",
      "mcp__jira",
    ]);
    const unexpected = args.filter((a) => !a.startsWith("--") && !expected.has(a));
    expect(unexpected).toEqual([]);
  });

  it("resumes by session id instead of starting over (M30)", () => {
    const args = buildClaudeArgs(opts({ resumeSessionId: SESSION_ID }));
    expect(pairAfter(args, "--resume")).toBe(SESSION_ID);
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("--fork-session");
  });

  it("pins a fresh session id when one is supplied", () => {
    const args = buildClaudeArgs(opts({ sessionId: SESSION_ID }));
    expect(pairAfter(args, "--session-id")).toBe(SESSION_ID);
    expect(args).not.toContain("--resume");
  });

  it("refuses to both pin and resume a session", () => {
    expect(() => buildClaudeArgs(opts({ sessionId: SESSION_ID, resumeSessionId: OTHER_SESSION_ID }))).toThrow(
      ClaudeConfigError,
    );
  });

  it("rejects a session id that is not a UUID", () => {
    expect(() => buildClaudeArgs(opts({ resumeSessionId: "session-7" }))).toThrow(/UUID/);
  });

  it("rejects empty binary path, empty model and unknown permission mode", () => {
    expect(() => buildClaudeArgs(opts({ binPath: "  " }))).toThrow(ClaudeConfigError);
    expect(() => buildClaudeArgs(opts({ model: "" }))).toThrow(ClaudeConfigError);
    expect(() => buildClaudeArgs(opts({ permissionMode: "yolo" as never }))).toThrow(ClaudeConfigError);
  });

  it("accepts every permission mode the CLI documents", () => {
    for (const mode of PERMISSION_MODES) {
      const args = buildClaudeArgs(opts({ permissionMode: mode, sandboxed: true }));
      expect(pairAfter(args, "--permission-mode")).toBe(mode);
    }
  });
});

// Y4 — the customer repository's own `.claude/` is hostile input.
describe("buildClaudeArgs — workspace configuration is never loaded", () => {
  it("loads user settings only, so the repo's .claude/settings.json hooks never run", () => {
    const args = buildClaudeArgs(opts());
    expect(pairAfter(args, "--setting-sources")).toBe("user");
  });

  it("disables customizations (CLAUDE.md, skills, plugins, agents, hooks) with --safe-mode", () => {
    expect(buildClaudeArgs(opts())).toContain("--safe-mode");
  });

  it("emits the containment pair on every single turn, resume included", () => {
    for (const over of [{}, { resumeSessionId: SESSION_ID }, { sessionId: SESSION_ID }]) {
      const args = buildClaudeArgs(opts(over));
      expect(args).toContain("--safe-mode");
      expect(pairAfter(args, "--setting-sources")).toBe("user");
    }
  });

  it("passes the platform's own settings file when it has one, and nothing otherwise", () => {
    expect(pairAfter(buildClaudeArgs(opts({ settingsPath: "/etc/maestro/claude.json" })), "--settings")).toBe(
      "/etc/maestro/claude.json",
    );
    expect(buildClaudeArgs(opts())).not.toContain("--settings");
    expect(buildClaudeArgs(opts({ settingsPath: "   " }))).not.toContain("--settings");
  });
});

// Y5 — availability vs permission. `--allowedTools` is an approval list; it
// does not decide which tools exist.
describe("buildClaudeArgs — the built-in tool set is pinned", () => {
  it("pins availability with --tools, not with --allowedTools", () => {
    const args = buildClaudeArgs(opts({ tools: ["Read", "Edit"] }));
    expect(valuesAfter(args, "--tools")).toEqual(["Read", "Edit"]);
  });

  it("disables the whole built-in set with the CLI's own empty-string token", () => {
    expect(valuesAfter(buildClaudeArgs(opts({ tools: [] })), "--tools")).toEqual([""]);
  });

  it("rejects a tool name that is not a plain identifier", () => {
    expect(() => buildClaudeArgs(opts({ tools: ["Bash(rm -rf /)"] }))).toThrow(ClaudeConfigError);
  });

  it("refuses bypassPermissions outside a sandbox — it voids every allow-list", () => {
    expect(() => buildClaudeArgs(opts({ permissionMode: "bypassPermissions" }))).toThrow(/sandboxed/);
    expect(() => buildClaudeArgs(opts({ permissionMode: "bypassPermissions", sandboxed: false }))).toThrow(/sandboxed/);
    expect(buildClaudeArgs(opts({ permissionMode: "bypassPermissions", sandboxed: true }))).toContain(
      "--permission-mode",
    );
  });
});

// Y6 — a missing config path must not mean "load everything".
describe("buildClaudeArgs — MCP narrowing is unconditional", () => {
  it("locks MCP access to the platform's own config", () => {
    const args = buildClaudeArgs(opts({ mcpServers: ["jira", "workspace"], mcpConfigPath: "/etc/maestro/mcp.json" }));
    expect(pairAfter(args, "--mcp-config")).toBe("/etc/maestro/mcp.json");
    expect(args).toContain("--strict-mcp-config");
    expect(valuesAfter(args, "--allowedTools")).toEqual(["mcp__jira", "mcp__workspace"]);
  });

  it("still emits --strict-mcp-config when there is no config file at all", () => {
    expect(buildClaudeArgs(opts({ mcpConfigPath: null }))).toContain("--strict-mcp-config");
    expect(buildClaudeArgs(opts({ mcpConfigPath: "   " }))).toContain("--strict-mcp-config");
  });

  it("refuses MCP servers with no config file rather than silently dropping them", () => {
    expect(() => buildClaudeArgs(opts({ mcpServers: ["jira"] }))).toThrow(/--mcp-config/);
    expect(() => buildClaudeArgs(opts({ mcpServers: ["jira"], mcpConfigPath: "  " }))).toThrow(/--mcp-config/);
  });

  it("rejects a server name that is not a plain identifier", () => {
    expect(() =>
      buildClaudeArgs(opts({ mcpServers: ["jira; rm -rf /"], mcpConfigPath: "/etc/mcp.json" })),
    ).toThrow(ClaudeConfigError);
  });
});

describe("buildClaudeEnv", () => {
  it("builds an allow-list, not a copy of the orchestrator's environment", () => {
    const env = buildClaudeEnv({ basePath: "/usr/bin", home: "/home/seat1", oauthToken: "tok", configDir: "/var/seat1" });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/seat1",
      [OAUTH_TOKEN_ENV]: "tok",
      [CONFIG_DIR_ENV]: "/var/seat1",
    });
  });

  it("omits the token when the seat is the machine's own login", () => {
    const env = buildClaudeEnv({ basePath: "/usr/bin", home: "/home/seat1", oauthToken: null });
    expect(env[OAUTH_TOKEN_ENV]).toBeUndefined();
    expect(env[CONFIG_DIR_ENV]).toBeUndefined();
  });

  // O9 — `extra` used to be spread last, so it overwrote the allow-list it was
  // supposed to sit inside.
  it("cannot redefine PATH, HOME or the seat's credentials through `extra`", () => {
    const env = buildClaudeEnv({
      basePath: "/usr/bin",
      home: "/home/seat1",
      oauthToken: "tok",
      configDir: "/var/seat1",
      extra: {
        PATH: "/tmp/evil",
        HOME: "/tmp/evil",
        [OAUTH_TOKEN_ENV]: "stolen",
        [CONFIG_DIR_ENV]: "/tmp/evil",
      },
    });
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["HOME"]).toBe("/home/seat1");
    expect(env[OAUTH_TOKEN_ENV]).toBe("tok");
    expect(env[CONFIG_DIR_ENV]).toBe("/var/seat1");
  });

  it("drops env names outside the pass-through list, ANTHROPIC_API_KEY included", () => {
    const env = buildClaudeEnv({
      basePath: "/usr/bin",
      home: "/home/seat1",
      oauthToken: "tok",
      extra: { ANTHROPIC_API_KEY: "sk-ant-x", AWS_SECRET_ACCESS_KEY: "s3cr3t", LD_PRELOAD: "/tmp/x.so" },
    });
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(env["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
    expect(env["LD_PRELOAD"]).toBeUndefined();
  });

  it("does forward the corporate proxy and TLS trust store", () => {
    const env = buildClaudeEnv({
      basePath: "/usr/bin",
      home: "/home/seat1",
      oauthToken: null,
      extra: { HTTPS_PROXY: "http://proxy.bank:8080", NODE_EXTRA_CA_CERTS: "/etc/ssl/bank.pem" },
    });
    expect(env["HTTPS_PROXY"]).toBe("http://proxy.bank:8080");
    expect(env["NODE_EXTRA_CA_CERTS"]).toBe("/etc/ssl/bank.pem");
  });
});
