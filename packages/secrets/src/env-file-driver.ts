import { CapabilityNotSupportedError, type SecretPort } from "@maestro/ports";
import { type Clock, systemClock, TtlCache } from "./cache.js";
import { ENV_FILE_DRIVER, type EnvFileConfig } from "./config.js";
import { SecretConfigError, SecretNotFoundError } from "./errors.js";
import { envVarName } from "./keys.js";
import { resolveKey } from "./shared.js";
import { resolveStage } from "./stage.js";

export type ReadTextFile = (path: string) => Promise<string>;

export interface EnvFileSecretPortOptions {
  config: EnvFileConfig;
  /** Environment source; defaults to `process.env`. Tests inject a record. */
  env?: Record<string, string | undefined>;
  /** Reader for `filePath`; defaults to node:fs/promises. */
  readFile?: ReadTextFile;
  /**
   * Deployment stage. Defaults to `process.env.NODE_ENV`, and can only make the
   * gate STRICTER: a production process stays production whatever is passed
   * here. Unrecognised values ("prod", "PROD", "staging") are refused.
   */
  nodeEnv?: unknown;
  clock?: Clock;
}

/**
 * Dev-only SecretPort backed by environment variables and an optional
 * dotenv-style file (M80).
 *
 * Two hard rules:
 *  - It REFUSES to exist in production (M6: secrets belong in Vault). The check
 *    is in the constructor, so no wiring path can slip past it, and it reads
 *    the AMBIENT stage as well as the injected one, so no caller can talk it
 *    open from inside a production process either.
 *  - It cannot issue short-lived credentials and says so with
 *    CapabilityNotSupportedError instead of faking a long-lived one (M44).
 */
export class EnvFileSecretPort implements SecretPort {
  readonly driver = ENV_FILE_DRIVER;
  readonly config: EnvFileConfig;
  readonly #env: Record<string, string | undefined>;
  readonly #readFile: ReadTextFile;
  readonly #cache: TtlCache<string>;
  #fileEntries: Promise<Record<string, string>> | null = null;

  constructor(options: EnvFileSecretPortOptions) {
    // The ambient stage wins whenever it is the stricter one — see resolveStage.
    if (resolveStage(options.nodeEnv) === "production") {
      throw new SecretConfigError(
        `the "${ENV_FILE_DRIVER}" driver is forbidden in production — use the "vault" driver (M6)`,
      );
    }
    this.config = options.config;
    this.#env = options.env ?? process.env;
    this.#readFile = options.readFile ?? defaultReadFile;
    this.#cache = new TtlCache<string>(options.config.cacheTtlSeconds, options.clock ?? systemClock);
  }

  async get(key: string): Promise<string> {
    const parsed = resolveKey(key, this.config.allowedMounts, ENV_FILE_DRIVER);

    const cached = this.#cache.get(key);
    if (cached !== undefined) return cached;

    const name = envVarName(parsed, this.config.envPrefix);
    // Environment wins over the file so an operator can override without editing it.
    const value = this.#env[name] ?? (await this.#file())[name];
    if (value === undefined || value.length === 0) throw new SecretNotFoundError(key, ENV_FILE_DRIVER);

    this.#cache.set(key, value);
    return value;
  }

  /** Not supported: only a real secrets engine can mint scoped, expiring creds. */
  async issueShortLived(_scope: string, _ttlSeconds: number): Promise<{ secret: string; expiresAt: string }> {
    throw new CapabilityNotSupportedError("SecretPort", "issueShortLived");
  }

  /**
   * Not supported: the environment and the optional dotenv file are read-only
   * sources this process does not own — rewriting a shell's exported variable or
   * a file the operator provisions would be a write with no durable home. A
   * console-entered connector token is stored by `EncryptedSecretStore` instead.
   */
  set(_key: string, _value: string): Promise<void> {
    return Promise.reject(new CapabilityNotSupportedError("SecretPort", "set"));
  }

  invalidate(): void {
    this.#cache.clear();
    this.#fileEntries = null;
  }

  toJSON(): { driver: string; allowedMounts: string[]; envPrefix: string; filePath: string | null } {
    return {
      driver: this.driver,
      allowedMounts: [...this.config.allowedMounts],
      envPrefix: this.config.envPrefix,
      filePath: this.config.filePath ?? null,
    };
  }

  toString(): string {
    return `EnvFileSecretPort(prefix=${this.config.envPrefix})`;
  }

  /** Read (and memoise) the optional file. A configured-but-unreadable file
   * fails loudly — a silently empty source is exactly the fail-open we forbid. */
  #file(): Promise<Record<string, string>> {
    const { filePath } = this.config;
    if (!filePath) return Promise.resolve({});
    this.#fileEntries ??= this.#readFile(filePath).then(parseDotEnv);
    return this.#fileEntries;
  }
}

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

/** Minimal dotenv parser — no interpolation, no multi-line values, no new dependency. */
export function parseDotEnv(text: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = LINE.exec(line);
    if (!match) continue;
    const [, name, rawValue] = match as unknown as [string, string, string];
    entries[name] = unquote(rawValue);
  }
  return entries;
}

function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  return quoted ? (quoted[2] ?? "") : value;
}

async function defaultReadFile(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}
