import type { PortRegistry, StoragePort } from "@maestro/ports";
import type { Clock, FetchLike, SqlExecutor } from "./deps.js";
import { StorageConfigError } from "./errors.js";
import { createPgBlobStorage } from "./pg.js";
import { createS3Storage } from "./s3.js";

export const STORAGE_PORT = "StoragePort";
export const S3_DRIVER = "s3-compat";
export const PG_BLOB_DRIVER = "pg-blob";

/**
 * M44 clean-room DI: the core resolves `StoragePort` by driver name and never
 * imports a driver module. The composition root passes the driver options
 * together with its runtime collaborators (`fetch` / `sql`, optional `now`).
 */
export function registerStorageDrivers(registry: PortRegistry): void {
  registry.register<StoragePort>(STORAGE_PORT, S3_DRIVER, (config) => {
    const { fetch, now, ...options } = asRecord(config, S3_DRIVER);
    if (typeof fetch !== "function") {
      throw new StorageConfigError([`fetch: ${S3_DRIVER} requires an injected fetch function`]);
    }
    return createS3Storage(options, { fetch: fetch as FetchLike, now: now as Clock | undefined });
  });

  registry.register<StoragePort>(STORAGE_PORT, PG_BLOB_DRIVER, (config) => {
    const { sql, now, ...options } = asRecord(config, PG_BLOB_DRIVER);
    if (!isSqlExecutor(sql)) {
      throw new StorageConfigError([`sql: ${PG_BLOB_DRIVER} requires an injected SqlExecutor`]);
    }
    return createPgBlobStorage(options, { sql, now: now as Clock | undefined });
  });
}

function asRecord(config: unknown, driver: string): Record<string, unknown> {
  if (typeof config !== "object" || config === null) {
    throw new StorageConfigError([`(root): ${driver} configuration must be an object`]);
  }
  return { ...(config as Record<string, unknown>) };
}

function isSqlExecutor(value: unknown): value is SqlExecutor {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SqlExecutor).query === "function"
  );
}
