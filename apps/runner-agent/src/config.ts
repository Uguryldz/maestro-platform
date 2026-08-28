import { readFileSync } from "node:fs";
import { AgentPlatform } from "@maestro/runners";
import { z } from "zod";
import { RunnerAgentConfigError } from "./errors.js";

/**
 * Agent configuration (task #9). Fail-closed: a missing mandatory setting
 * refuses to start rather than guessing a default, because every guess here is
 * a security decision — a wrong platform URL is an agent that offers a bank's
 * build machine to whoever answers.
 *
 * Precedence: environment OVERRIDES file. Env is what the service manager
 * (launchd/nssm) controls, and the file is the checked-in baseline.
 */

/** How the agent finds its shared secret. Never the secret itself. */
export const TokenRef = z.object({
  /**
   * `env` reads one variable; `secret-port` resolves a key through
   * `SecretPort`. There is deliberately no `literal` / `inline` source: a token
   * written into the config file is a token on disk in plain text (task #1).
   */
  source: z.enum(["env", "secret-port"]),
  /** Variable name, or the SecretPort key. */
  key: z.string().min(1),
});
export type TokenRef = z.infer<typeof TokenRef>;

export const LogLevel = z.enum(["debug", "info", "warn", "error"]);
export type LogLevel = z.infer<typeof LogLevel>;

export const RunnerAgentConfig = z.object({
  /** Where the agent dials OUT to. https is required outside development. */
  platformUrl: z.url(),
  agentId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
  platform: AgentPlatform,
  agentVersion: z.string().min(1),
  /** Concurrent sandboxes this machine will run. */
  capacity: z.number().int().min(1).max(16),
  labels: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9._-]*$/))
    .max(32)
    .default([]),
  tokenRef: TokenRef,
  /**
   * Lowest level that reaches the log sink. Enforced in `agent.ts`; an operator
   * who sets `error` sees errors only.
   *
   * There is deliberately NO `workDir` here. The agent does not own a working
   * directory: the sandbox's storage is the runner driver's business (docker
   * volumes for linux, the agent's own installation for win/mac), and this
   * process never writes a file. It used to be a MANDATORY setting that nothing
   * read, which promised the operator control over where the bank's source
   * landed and delivered none of it.
   */
  logLevel: LogLevel.default("info"),
  /** Seconds between work-pull attempts when the agent has spare capacity. */
  pullIntervalSeconds: z.number().int().min(1).max(300).default(5),
  /** How long before a lease expires the agent tries to renew it. */
  leaseRenewMarginSeconds: z.number().int().min(1).max(600).default(30),
  /** Grace given to running jobs during a graceful shutdown before leases are dropped. */
  shutdownGraceSeconds: z.number().int().min(0).max(3_600).default(60),
  /** Request timeout for one platform call. */
  requestTimeoutMs: z.number().int().min(100).max(120_000).default(15_000),
});
export type RunnerAgentConfig = z.infer<typeof RunnerAgentConfig>;

const ENV_PREFIX = "MAESTRO_AGENT_";

function envName(suffix: string): string {
  return `${ENV_PREFIX}${suffix}`;
}

/** Parses a positive integer from an env var, refusing junk instead of coercing to NaN. */
function readInt(source: Record<string, string | undefined>, suffix: string): number | undefined {
  const raw = source[envName(suffix)];
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new RunnerAgentConfigError(`${envName(suffix)} must be an integer, got "${raw}"`);
  }
  return value;
}

function readList(source: Record<string, string | undefined>, suffix: string): string[] | undefined {
  const raw = source[envName(suffix)];
  if (raw === undefined) return undefined;
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** The env layer, as a sparse object: absent keys must not overwrite file values. */
function fromEnv(source: Record<string, string | undefined>): Record<string, unknown> {
  const tokenSource = source[envName("TOKEN_SOURCE")];
  const tokenKey = source[envName("TOKEN_KEY")];
  const layer: Record<string, unknown> = {
    platformUrl: source[envName("PLATFORM_URL")],
    agentId: source[envName("ID")],
    platform: source[envName("PLATFORM")],
    agentVersion: source[envName("VERSION")],
    capacity: readInt(source, "CAPACITY"),
    labels: readList(source, "LABELS"),
    logLevel: source[envName("LOG_LEVEL")],
    pullIntervalSeconds: readInt(source, "PULL_INTERVAL_SECONDS"),
    leaseRenewMarginSeconds: readInt(source, "LEASE_RENEW_MARGIN_SECONDS"),
    shutdownGraceSeconds: readInt(source, "SHUTDOWN_GRACE_SECONDS"),
    requestTimeoutMs: readInt(source, "REQUEST_TIMEOUT_MS"),
    ...(tokenSource === undefined && tokenKey === undefined
      ? {}
      : { tokenRef: { source: tokenSource, key: tokenKey } }),
  };
  for (const [key, value] of Object.entries(layer)) {
    if (value === undefined) delete layer[key];
  }
  return layer;
}

function readConfigFile(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new RunnerAgentConfigError(
      `config file "${path}" cannot be read: ${error instanceof Error ? error.name : "unknown error"}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RunnerAgentConfigError(`config file "${path}" is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RunnerAgentConfigError(`config file "${path}" must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export interface LoadConfigOptions {
  env?: Record<string, string | undefined>;
  /** Explicit path; otherwise `MAESTRO_AGENT_CONFIG`. No config file is fine if env is complete. */
  configPath?: string;
}

/**
 * Builds the effective configuration. Anything invalid throws — there is no
 * partially-configured agent, because "half configured" on this component
 * means "running jobs with a policy nobody chose".
 */
export function loadRunnerAgentConfig(options: LoadConfigOptions = {}): RunnerAgentConfig {
  const env = options.env ?? process.env;
  const path = options.configPath ?? env[envName("CONFIG")];
  const fileLayer = path === undefined ? {} : readConfigFile(path);
  const merged = { ...fileLayer, ...fromEnv(env) };

  const parsed = RunnerAgentConfig.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new RunnerAgentConfigError(issues);
  }
  const config = parsed.data;

  // A plaintext token endpoint would put the shared secret on the wire (M22).
  if (env["NODE_ENV"] === "production" && !config.platformUrl.startsWith("https://")) {
    throw new RunnerAgentConfigError("platformUrl must use https in production");
  }
  return config;
}
