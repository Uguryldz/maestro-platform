import { ClaudeConfigError } from "./errors.js";

/**
 * Flag surface of the LOCAL `claude` CLI (M55/M107 subscription driver): the
 * seat is an interactive login, not an API key, so the driver drives the binary
 * instead of an HTTP endpoint.
 *
 * Every flag below came out of `claude --help` (v2.1.226) — RAPOR §2. Three
 * facts from that output shape this file:
 *  · `--output-format stream-json` is rejected with `--print` unless `--verbose`
 *    is given too, so the two are emitted as a pair and never apart.
 *  · `--bare` is deliberately NOT used although it looks like the right
 *    isolation switch: it makes Anthropic auth "strictly ANTHROPIC_API_KEY or
 *    apiKeyHelper (OAuth and keychain are never read)" — exactly the credential
 *    a subscription seat does not have.
 *  · The agent runs INSIDE a customer repository, so the repository's own
 *    `.claude/` directory is hostile input. Closing that surface is
 *    `--safe-mode` plus `--setting-sources` — see `ISOLATION_ARGS`.
 */
export const PERMISSION_MODES = [
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "manual",
  "dontAsk",
  "plan",
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Env var the CLI reads for a subscription seat token (`claude setup-token`). */
export const OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
/** Per-seat config dir, so pooled seats (M55) never share session state. */
export const CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR";

/** Session ids the CLI accepts for `--session-id` are UUIDs. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The customer-repository containment pair, emitted unconditionally.
 *
 * `--setting-sources user` is the load-bearing half. `claude --help` documents
 * the flag as "Comma-separated list of setting sources to load (user, project,
 * local)" and the shipped binary defaults it to all three, so WITHOUT this flag
 * the workspace's own `.claude/settings.json` and `.claude/settings.local.json`
 * are read — settings that can carry `hooks`, i.e. arbitrary commands the CLI
 * runs on the bank's runner. The M52 gate cannot see that: it inspects a git
 * diff after the fact, and a hook executes before any diff exists.
 *
 * `--safe-mode` is the second, independent half: "all customizations (CLAUDE.md,
 * skills, plugins, hooks, MCP servers, custom commands and agents, output
 * styles, workflows, …) disabled … Auth, model selection, built-in tools, and
 * permissions work normally". Auth still working is why this is usable here and
 * `--bare` is not. It also disables CLAUDE.md discovery, which is how a
 * repository injects instructions into a turn.
 *
 * "MCP servers disabled" in that text covers DISCOVERED servers; servers handed
 * over explicitly with `--mcp-config` are the platform's own file and are what
 * this driver relies on (RAPOR §2).
 */
export const ISOLATION_ARGS: readonly string[] = ["--safe-mode", "--setting-sources", "user"];

export interface ClaudeCliOptions {
  readonly binPath: string;
  readonly model: string;
  /**
   * Built-in tools the turn may USE (`--tools`). Required, and not the same
   * thing as `--allowedTools`: `claude --help` separates availability
   * ("Specify the list of available tools from the built-in set") from
   * permission ("list of tool names to allow"). An empty list disables the
   * built-in set entirely; `["default"]` restores all of it.
   */
  readonly tools: readonly string[];
  /** MCP server names the turn may reach (K66: servers, not raw tools). */
  readonly mcpServers: readonly string[];
  /** Path to the MCP config file; `null` still emits `--strict-mcp-config`. */
  readonly mcpConfigPath: string | null;
  /** Required on purpose: a default would be this package quietly deciding how
   * much a bank's agent may do unattended. */
  readonly permissionMode: PermissionMode;
  /** The PLATFORM's settings file (`--settings`), never the workspace's. */
  readonly settingsPath?: string | null;
  /**
   * True only when the turn runs in a throw-away sandbox. It is the sole place
   * `bypassPermissions` is allowed: that mode makes `--allowedTools` moot, so
   * on a shared runner it is a permission system switched off.
   */
  readonly sandboxed?: boolean;
  /** Fresh session: pin our own id. Mutually exclusive with `resumeSessionId`. */
  readonly sessionId?: string | null;
  /** Resume a previous turn (`--resume <sessionId>`), M30. */
  readonly resumeSessionId?: string | null;
}

function assertServerName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
    throw new ClaudeConfigError(`MCP server name "${name}" is not a plain identifier`);
  }
}

/** Built-in tool names are bare identifiers; `default` is the CLI's own token. */
function assertToolName(name: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    throw new ClaudeConfigError(`built-in tool name "${name}" is not a plain identifier`);
  }
}

function blank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === "";
}

function assertSessionIds(opts: ClaudeCliOptions): { resume: string | null; fresh: string | null } {
  const resume = opts.resumeSessionId ?? null;
  const fresh = opts.sessionId ?? null;
  if (resume !== null && fresh !== null) {
    throw new ClaudeConfigError("--session-id pins a NEW session; it cannot be combined with --resume");
  }
  for (const id of [resume, fresh]) {
    if (id !== null && !UUID_PATTERN.test(id)) {
      throw new ClaudeConfigError(`session id "${id}" is not a UUID; the CLI requires one`);
    }
  }
  return { resume, fresh };
}

function toolArgs(tools: readonly string[]): string[] {
  // `--tools ""` is the CLI's documented way to say "no built-in tools".
  if (tools.length === 0) return ["--tools", ""];
  for (const tool of tools) assertToolName(tool);
  return ["--tools", ...tools];
}

function mcpArgs(opts: ClaudeCliOptions): string[] {
  // Unconditional: without it the workspace's own `.mcp.json` and the
  // operator's user-level servers load, which is the opposite of narrowing.
  const args = ["--strict-mcp-config"];
  if (!blank(opts.mcpConfigPath)) args.push("--mcp-config", (opts.mcpConfigPath as string).trim());
  else if (opts.mcpServers.length > 0) {
    throw new ClaudeConfigError("mcpServers were requested but no --mcp-config path was given");
  }
  if (opts.mcpServers.length === 0) return args;
  args.push("--allowedTools", ...opts.mcpServers.map((name) => {
    assertServerName(name);
    return `mcp__${name}`;
  }));
  return args;
}

/**
 * Argv for one non-interactive turn. The prompt is NOT here: it goes over
 * stdin, so a task containing a leading dash or a newline can never be read as
 * a flag, and it never lands in the process table where `ps` would show it.
 */
export function buildClaudeArgs(opts: ClaudeCliOptions): string[] {
  if (opts.binPath.trim() === "") throw new ClaudeConfigError("claude binary path is empty");
  if (opts.model.trim() === "") throw new ClaudeConfigError("model is empty");
  if (!PERMISSION_MODES.includes(opts.permissionMode)) {
    throw new ClaudeConfigError(`unknown permission mode "${opts.permissionMode}"`);
  }
  if (opts.permissionMode === "bypassPermissions" && opts.sandboxed !== true) {
    throw new ClaudeConfigError(
      "permission mode bypassPermissions overrides every allow-list; it is only available with sandboxed: true",
    );
  }
  const { resume, fresh } = assertSessionIds(opts);

  // `--verbose` is a pair with stream-json, not decoration: the CLI refuses
  // `--print --output-format stream-json` without it.
  const args = ["--print", "--output-format", "stream-json", "--verbose", "--input-format", "text"];
  args.push("--model", opts.model, "--permission-mode", opts.permissionMode);
  args.push(...ISOLATION_ARGS);
  if (!blank(opts.settingsPath)) args.push("--settings", (opts.settingsPath as string).trim());
  args.push(...toolArgs(opts.tools));
  args.push(...mcpArgs(opts));

  if (resume !== null) args.push("--resume", resume);
  else if (fresh !== null) args.push("--session-id", fresh);

  return args;
}

/**
 * Environment names a bank runner legitimately has to pass through: a corporate
 * proxy and its TLS trust store. Anything outside this list — starting with
 * `ANTHROPIC_API_KEY`, which would silently switch the seat off subscription
 * auth — is dropped rather than forwarded.
 */
export const PASSTHROUGH_ENV: readonly string[] = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "LANG",
  "TZ",
];

/**
 * Child environment, an explicit allow-list rather than `process.env`: an agent
 * turn must not inherit whatever secrets sit in the orchestrator's env (M80).
 * `extra` is filtered against `PASSTHROUGH_ENV` and applied FIRST, so it can
 * never redefine `PATH`, `HOME` or the seat's credentials.
 */
export function buildClaudeEnv(input: {
  readonly basePath: string;
  readonly home: string;
  readonly oauthToken: string | null;
  readonly configDir?: string | null;
  readonly extra?: Readonly<Record<string, string>>;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSTHROUGH_ENV) {
    const value = input.extra?.[name];
    if (value !== undefined) env[name] = value;
  }
  env["PATH"] = input.basePath;
  env["HOME"] = input.home;
  if (input.oauthToken !== null) env[OAUTH_TOKEN_ENV] = input.oauthToken;
  if (input.configDir != null && input.configDir !== "") env[CONFIG_DIR_ENV] = input.configDir;
  return env;
}
