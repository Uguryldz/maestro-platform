import { z } from "zod";
import { CapabilityNotSupportedError } from "@maestro/ports";
import type { StoragePort } from "@maestro/ports";
import type { Clock, SqlExecutor } from "./deps.js";
import { systemClock } from "./deps.js";
import {
  ObjectLockedError,
  ObjectLockNotConfiguredError,
  ObjectNotFoundError,
  StorageConfigError,
} from "./errors.js";
import {
  assertKeyByteLength,
  assertValidKey,
  assertValidPrefix,
  RETENTION_YEARS_DEFAULT,
  retainUntil,
  RetentionClass,
  retentionClassForKey,
  retentionPolicy,
  retentionTags,
} from "./keys.js";

/** Alias the upsert uses to read the row it is about to replace. */
const EXISTING = "existing";

/**
 * pg-blob driver options (M5: the small-installation backend, no S3 required).
 * Same retention semantics as s3-compat so callers cannot tell the two apart.
 */
export const PgBlobStorageOptions = z.strictObject({
  /** Physical table; qualified name is validated, never interpolated blindly. */
  table: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/, "table must be a plain [schema.]name")
    .default("storage_blob"),
  /** Optional tenant prefix prepended to every key. Invisible to callers. */
  keyPrefix: z.string().default(""),
  /** M57 WORM emulation. Absent means objectLock puts are refused, not downgraded. */
  objectLock: z
    .strictObject({
      mode: z.enum(["COMPLIANCE", "GOVERNANCE"]),
      years: z.number().int().positive().default(RETENTION_YEARS_DEFAULT),
    })
    .optional(),
  retentionClass: RetentionClass.default("evidence"),
});
export type PgBlobStorageOptions = z.output<typeof PgBlobStorageOptions>;

export interface PgBlobStorageDeps {
  sql: SqlExecutor;
  now?: Clock | undefined;
}

interface BlobRow {
  data: Uint8Array;
}

interface LockRow {
  object_lock: boolean;
  /**
   * A `timestamptz` comes back as an ISO string from a raw `pg` client and as a
   * `Date` from Prisma's. Both are accepted rather than normalised at the seam:
   * `new Date(...)` below handles either, and narrowing this to one of them
   * would make the WORM check silently wrong on the other adapter.
   */
  retain_until: string | Date | null;
}

/** DDL for the backing table; applied by the `db` packet's migration. */
export function pgBlobTableDdl(table = "storage_blob"): string {
  const name = PgBlobStorageOptions.shape.table.parse(table);
  return [
    `CREATE TABLE IF NOT EXISTS ${name} (`,
    `  key text PRIMARY KEY,`,
    `  data bytea NOT NULL,`,
    `  content_type text NOT NULL,`,
    `  tags jsonb NOT NULL,`,
    `  object_lock boolean NOT NULL DEFAULT false,`,
    `  retain_until timestamptz,`,
    `  created_at timestamptz NOT NULL,`,
    `  updated_at timestamptz NOT NULL`,
    `);`,
    // `list` is a LIKE 'prefix%' scan; outside the C collation the primary key's
    // btree cannot serve it, so every listing would read the whole table.
    `CREATE INDEX IF NOT EXISTS ${name.replace(".", "_")}_key_pattern_idx`,
    `  ON ${name} (key text_pattern_ops)`,
  ].join("\n");
}

export class PgBlobStorage implements StoragePort {
  private readonly now: Clock;

  constructor(
    private readonly options: PgBlobStorageOptions,
    private readonly deps: PgBlobStorageDeps,
  ) {
    if (options.keyPrefix !== "") assertValidPrefix(options.keyPrefix);
    this.now = deps.now ?? systemClock;
  }

  async put(
    key: string,
    data: Uint8Array,
    opts?: { contentType?: string; objectLock?: boolean },
  ): Promise<void> {
    const full = this.fullKey(key);
    let retainUntilAt: string | null = null;
    if (opts?.objectLock === true) {
      const lock = this.options.objectLock;
      if (!lock) throw new ObjectLockNotConfiguredError(key);
      retainUntilAt = retainUntil(this.now().toISOString(), lock.years);
    }
    await this.assertNotRetained(key, full);
    const at = this.now().toISOString();
    const retentionClass = retentionClassForKey(key, this.options.retentionClass);
    await this.deps.sql.query(
      `INSERT INTO ${this.options.table} AS ${EXISTING} ` +
        `(key, data, content_type, tags, object_lock, retain_until, created_at, updated_at) ` +
        // The casts are not decoration. `tags` is bound as a JSON *string* and
        // the three instants as ISO *strings*; an adapter that binds parameters
        // as text — Prisma's `$queryRawUnsafe`, which is the executor the worker
        // actually composes — then hands Postgres `text` for a `jsonb` and a
        // `timestamptz` column, and it refuses to infer the conversion:
        // `column "tags" is of type jsonb but expression is of type text`
        // (42804). Every put failed on that, which is how a finished analysis
        // came to attach nothing. Stating the type makes the statement correct
        // for every binding style instead of relying on one driver's inference.
        `VALUES ($1, $2, $3, $4::jsonb, $5, $6::timestamptz, $7::timestamptz, $7::timestamptz) ` +
        `ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, ` +
        `content_type = EXCLUDED.content_type, tags = EXCLUDED.tags, ` +
        // WORM columns are merged, never replaced: an ordinary put must not be
        // able to erase a retention a previous locked put established (M57).
        `object_lock = (${EXISTING}.object_lock OR EXCLUDED.object_lock), ` +
        `retain_until = GREATEST(${EXISTING}.retain_until, EXCLUDED.retain_until), ` +
        `updated_at = EXCLUDED.updated_at`,
      [
        full,
        // node-postgres only writes a Buffer into bytea; a bare Uint8Array is
        // serialised as a JSON object and the evidence is silently corrupted.
        Buffer.from(data),
        opts?.contentType ?? "application/octet-stream",
        JSON.stringify(retentionTags(retentionPolicy(retentionClass))),
        retainUntilAt !== null,
        retainUntilAt,
        at,
      ],
    );
  }

  async get(key: string): Promise<Uint8Array> {
    const full = this.fullKey(key);
    const rows = await this.deps.sql.query<BlobRow>(
      `SELECT data FROM ${this.options.table} WHERE key = $1`,
      [full],
    );
    const row = rows[0];
    if (!row) throw new ObjectNotFoundError(key);
    return new Uint8Array(row.data);
  }

  async list(prefix: string): Promise<string[]> {
    assertValidPrefix(prefix);
    const rows = await this.deps.sql.query<{ key: string }>(
      `SELECT key FROM ${this.options.table} WHERE key LIKE $1 ORDER BY key ASC`,
      [`${likeEscape(`${this.options.keyPrefix}${prefix}`)}%`],
    );
    return rows.map((row) => row.key.slice(this.options.keyPrefix.length));
  }

  /** Idempotent by contract: deleting an absent key is a no-op on both drivers. */
  async delete(key: string): Promise<void> {
    const full = this.fullKey(key);
    await this.assertNotRetained(key, full);
    await this.deps.sql.query(`DELETE FROM ${this.options.table} WHERE key = $1`, [full]);
  }

  /**
   * Postgres has no signed-URL concept and this package will not invent an
   * unauthenticated one; the BFF serves pg-blob objects behind its own auth.
   */
  presign(_key: string, _ttlSeconds: number): Promise<string> {
    return Promise.reject(new CapabilityNotSupportedError("StoragePort", "presign"));
  }

  /**
   * WORM enforcement (M57): a retained row may be neither overwritten nor
   * deleted. The check reads the ROW, never the configuration — the protection
   * belongs to the stored object, so removing `objectLock` from the deployment
   * must not make ten years of retention evaporate.
   */
  private async assertNotRetained(key: string, full: string): Promise<void> {
    const rows = await this.deps.sql.query<LockRow>(
      `SELECT object_lock, retain_until FROM ${this.options.table} WHERE key = $1`,
      [full],
    );
    const row = rows[0];
    if (!row?.object_lock || row.retain_until === null) return;
    if (new Date(row.retain_until).getTime() > this.now().getTime()) {
      throw new ObjectLockedError(key, new Date(row.retain_until).toISOString());
    }
  }

  private fullKey(key: string): string {
    assertValidKey(key);
    const full = `${this.options.keyPrefix}${key}`;
    // The stored key includes the tenant prefix; keep both drivers' limits equal.
    assertKeyByteLength(full);
    return full;
  }
}

/** Escapes LIKE wildcards so a prefix containing % or _ stays literal. */
function likeEscape(value: string): string {
  return value.replace(/([\\%_])/g, "\\$1");
}

export function createPgBlobStorage(options: unknown, deps: PgBlobStorageDeps): StoragePort {
  const parsed = PgBlobStorageOptions.safeParse(options);
  if (!parsed.success) {
    throw new StorageConfigError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  return new PgBlobStorage(parsed.data, deps);
}
