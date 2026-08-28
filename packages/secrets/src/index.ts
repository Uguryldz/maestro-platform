export * from "./cache.js";
export * from "./config.js";
export * from "./env-file-driver.js";
export * from "./errors.js";
export * from "./keys.js";
export * from "./register.js";
export * from "./shared.js";
export * from "./stage.js";
export * from "./vault-driver.js";

/**
 * `VaultClient` is exported as a TYPE only, on purpose. It speaks raw Vault
 * paths, so it sits BELOW the mount allow-list every driver enforces
 * (`client.read("sys/policies/acl")` would answer): handing it to a caller
 * would be handing out a way around least privilege (M6). The composition root
 * gets its Vault access through `createVaultSecretPort` / `registerSecretDrivers`.
 */
export type {
  AppRoleCredentials,
  FetchLike,
  VaultBody,
  VaultClient,
  VaultClientOptions,
  VaultReadResult,
} from "./vault-client.js";
