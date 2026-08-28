import type { PortRegistry } from "@maestro/ports";
import type { z } from "zod";
import type { Clock } from "./cache.js";
import { ENV_FILE_DRIVER, EnvFileConfig, SECRET_PORT, VAULT_DRIVER, VaultConfig } from "./config.js";
import { EnvFileSecretPort, type ReadTextFile } from "./env-file-driver.js";
import { SecretConfigError } from "./errors.js";
import { type AppRoleCredentials, type FetchLike, VaultClient } from "./vault-client.js";
import { VaultSecretPort } from "./vault-driver.js";

/**
 * Runtime collaborators a declarative config cannot carry. `DriverFactory` is
 * `(config: unknown) => P`, so the composition root passes them in the same
 * object under `deps` — the convention adapter-jira already uses.
 */
export interface VaultDeps {
  approle: AppRoleCredentials;
  fetchImpl?: FetchLike;
  clock?: Clock;
}

export interface EnvFileDeps {
  env?: Record<string, string | undefined>;
  readFile?: ReadTextFile;
  /** Validated (and only ever hardened) by the driver — see src/stage.ts. */
  nodeEnv?: unknown;
  clock?: Clock;
}

export function createVaultSecretPort(input: unknown): VaultSecretPort {
  const config = parse(VaultConfig, input, VAULT_DRIVER);
  const deps = depsOf<VaultDeps>(input);
  const approle = deps?.approle;
  if (typeof approle?.roleId !== "string" || typeof approle.secretId !== "string") {
    throw new SecretConfigError("deps.approle.roleId/secretId are required — Vault login has no default (M6)");
  }

  const client = new VaultClient({ config, approle, fetchImpl: deps?.fetchImpl, clock: deps?.clock });
  return new VaultSecretPort({ config, client, clock: deps?.clock });
}

/**
 * Throws in production before any secret is read (M6) — see EnvFileSecretPort.
 * `deps` is runtime wiring and deliberately not part of the Zod config, so the
 * one value that can weaken a gate (`nodeEnv`) is validated by the driver
 * itself rather than trusted from here.
 */
export function createEnvFileSecretPort(input: unknown): EnvFileSecretPort {
  const config = parse(EnvFileConfig, input, ENV_FILE_DRIVER);
  const deps = depsOf<EnvFileDeps>(input);
  return new EnvFileSecretPort({
    config,
    env: deps?.env,
    readFile: deps?.readFile,
    nodeEnv: deps?.nodeEnv,
    clock: deps?.clock,
  });
}

/**
 * Register both SecretPort drivers (M44 clean-room DI): the core never imports
 * this module, the composition root calls this once at boot.
 */
export function registerSecretDrivers(registry: PortRegistry): void {
  registry.register(SECRET_PORT, VAULT_DRIVER, createVaultSecretPort);
  registry.register(SECRET_PORT, ENV_FILE_DRIVER, createEnvFileSecretPort);
}

function parse<T>(schema: z.ZodType<T>, input: unknown, driver: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new SecretConfigError(`${driver}: ${issues}`);
  }
  return result.data;
}

function depsOf<T>(input: unknown): T | undefined {
  const deps = (input as { deps?: unknown } | null | undefined)?.deps;
  return typeof deps === "object" && deps !== null ? (deps as T) : undefined;
}
