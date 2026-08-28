import { Prisma, PrismaClient } from "@prisma/client";

/**
 * How a caller clears a nullable Json column.
 *
 * Prisma REFUSES a bare `null` on a Json field, and the refusal is a good one:
 * there, `null` is ambiguous between "store the JSON value null" and "set the
 * column to SQL NULL". It makes you name the intent — `JsonNull` for the first,
 * `DbNull` for the second.
 *
 * Re-exported here rather than imported from `@prisma/client` at the call site,
 * for the same reason `Db` is: this package exists so the client stays an
 * implementation detail. A store that invented its own sentinel instead would
 * type-check and pass its tests against a fake, then write the literal object
 * `{"_tag":"DbNull"}` into the column — which is exactly what happened to
 * `ListeningRule.statusMapJson` before this export existed.
 */
export const DB_NULL = Prisma.DbNull;
export type DbNull = typeof Prisma.DbNull;

/**
 * The one database handle the platform passes around. Packages depend on
 * this type, never on `@prisma/client` directly, so the client version and
 * generation strategy stay an implementation detail of `@maestro/db`.
 */
export type Db = PrismaClient;

/** Log levels forwarded to Prisma; `query` is dev-only (it echoes SQL). */
export type DbLogLevel = "query" | "info" | "warn" | "error";

export interface CreateDbOptions {
  /** Defaults to `["warn", "error"]` — silent success, loud failure. */
  log?: readonly DbLogLevel[];
}

export class InvalidDatabaseUrlError extends Error {
  constructor(reason: string) {
    // The URL itself is never echoed: it carries the database password.
    super(`invalid DATABASE_URL: ${reason}`);
    this.name = "InvalidDatabaseUrlError";
  }
}

const POSTGRES_PROTOCOLS = new Set(["postgres:", "postgresql:"]);

/**
 * Fail-closed URL check (M6). A malformed or non-Postgres URL is a
 * configuration bug, and we would rather crash at wiring time than surface
 * it as a mysterious connection error mid-workflow.
 */
export function assertPostgresUrl(url: string): void {
  if (url.trim().length === 0) throw new InvalidDatabaseUrlError("empty");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidDatabaseUrlError("not a URL");
  }
  if (!POSTGRES_PROTOCOLS.has(parsed.protocol)) {
    throw new InvalidDatabaseUrlError(`expected postgresql://, got ${parsed.protocol}//`);
  }
  if (parsed.pathname.replace(/^\//, "").length === 0) {
    throw new InvalidDatabaseUrlError("no database name in path");
  }
}

/**
 * Build a typed client for `url`. Construction is lazy: Prisma opens the
 * connection pool on the first query, so this is safe to call in tests and
 * at module wiring time.
 */
export function createDb(url: string, options: CreateDbOptions = {}): Db {
  assertPostgresUrl(url);
  return new PrismaClient({
    datasourceUrl: url,
    log: [...(options.log ?? ["warn", "error"])],
  });
}
