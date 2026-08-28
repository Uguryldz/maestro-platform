import type {
  ConnectionRecord,
  ConnectionStore,
  ConnectionTestResult,
} from "@maestro/bff";
import type { Connection, ConnectionAuthKind, ConnectionKind } from "@maestro/contracts";

/**
 * The Postgres-backed `ConnectionStore` (connector-management surface).
 *
 * A connection is platform configuration an admin edits from Studio, so it must
 * survive a restart the same way parameters and templates do — a process-local
 * store would drop an operator's newly-wired Jira the moment the container
 * bounced. This reads and writes the `Connection` table (migration 0010).
 *
 * The row never holds a token: only `secretRef` (a reference into
 * `ConnectorSecret`, written by `EncryptedSecretStore`) and `secretMask`. That
 * is the property that makes "a database dump does not leak a token" true at the
 * table level — the ciphertext is in a different table, and its key is in the
 * environment.
 *
 * The delegate is structural, like every other store here: `apps/bff` must not
 * depend on the generated client, and this file compiles before
 * `prisma generate` has run.
 */

/** One `Connection` row, as read/written. */
export interface ConnectionRow {
  id: string;
  kind: string;
  displayName: string;
  baseUrl: string;
  authKind: string;
  configJson: unknown;
  secretRef: string | null;
  secretMask: string | null;
  enabled: boolean;
  /** M18: whether this endpoint runs inside the institution. */
  onPrem: boolean;
  /** Which model answers when a run names none; at most one row may hold it. */
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastTestedAt: Date | null;
  lastTestOk: boolean | null;
  lastTestNote: string | null;
}

/**
 * The row as WRITTEN. Identical to `ConnectionRow` except `configJson` is a
 * plain `object` rather than `unknown`: Prisma's generated `create`/`update`
 * inputs demand a JSON-serialisable value there, and `unknown` would not
 * satisfy them. The config is a validated `Record<string, string>` by the time
 * it reaches here, so an `object` is honest.
 */
export type ConnectionWriteRow = Omit<ConnectionRow, "configJson"> & { configJson: object };

export interface ConnectionDelegate {
  findMany(args: { orderBy: { id: "asc" } }): Promise<ConnectionRow[]>;
  findUnique(args: { where: { id: string } }): Promise<ConnectionRow | null>;
  upsert(args: {
    where: { id: string };
    create: ConnectionWriteRow;
    update: Omit<ConnectionWriteRow, "id" | "createdAt">;
  }): Promise<unknown>;
  update(args: {
    where: { id: string };
    data: { lastTestedAt: Date; lastTestOk: boolean; lastTestNote: string | null };
  }): Promise<unknown>;
  delete(args: { where: { id: string } }): Promise<ConnectionRow>;
}

export class PrismaConnectionStore implements ConnectionStore {
  constructor(private readonly connections: ConnectionDelegate) {}

  async list(): Promise<readonly ConnectionRecord[]> {
    const rows = await this.connections.findMany({ orderBy: { id: "asc" } });
    return rows.map(toRecord);
  }

  async get(id: string): Promise<ConnectionRecord | null> {
    const row = await this.connections.findUnique({ where: { id } });
    return row === null ? null : toRecord(row);
  }

  async put(record: ConnectionRecord): Promise<void> {
    const row = toRow(record);
    const { id: _id, createdAt: _createdAt, ...update } = row;
    await this.connections.upsert({ where: { id: record.id }, create: row, update });
  }

  async recordTest(id: string, result: ConnectionTestResult): Promise<void> {
    await this.connections.update({
      where: { id },
      data: {
        lastTestedAt: new Date(result.at),
        lastTestOk: result.ok,
        lastTestNote: result.note ?? null,
      },
    });
  }

  async remove(id: string): Promise<{ secretRef: string | null } | null> {
    // `delete` throws when the row is absent; the route has already loaded it,
    // but a concurrent delete is turned into the "not found" the contract wants
    // rather than an unhandled Prisma error.
    try {
      const row = await this.connections.delete({ where: { id } });
      return { secretRef: row.secretRef };
    } catch {
      return null;
    }
  }
}

/**
 * A stored kind/authKind string, narrowed to the contract union.
 *
 * The Zod validator already refused anything else on the way in, so this only
 * fires on a hand-edited row or a schema skew; the cast is honest because the
 * write path is the only producer and it is validated.
 */
function toRecord(row: ConnectionRow): ConnectionRecord {
  return {
    id: row.id,
    kind: row.kind as ConnectionKind,
    displayName: row.displayName,
    baseUrl: row.baseUrl,
    authKind: row.authKind as ConnectionAuthKind,
    config: toConfig(row.configJson),
    secretRef: row.secretRef,
    secretMask: row.secretMask,
    enabled: row.enabled,
    onPrem: row.onPrem,
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastTestedAt: row.lastTestedAt === null ? null : row.lastTestedAt.toISOString(),
    lastTestOk: row.lastTestOk,
    lastTestNote: row.lastTestNote,
  };
}

function toRow(record: ConnectionRecord): ConnectionWriteRow {
  return {
    id: record.id,
    kind: record.kind,
    displayName: record.displayName,
    baseUrl: record.baseUrl,
    authKind: record.authKind,
    configJson: record.config,
    secretRef: record.secretRef,
    secretMask: record.secretMask,
    enabled: record.enabled,
    onPrem: record.onPrem,
    isDefault: record.isDefault,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
    lastTestedAt: record.lastTestedAt === null ? null : new Date(record.lastTestedAt),
    lastTestOk: record.lastTestOk,
    lastTestNote: record.lastTestNote,
  };
}

/**
 * The JSON config column, narrowed to `Record<string, string>`.
 *
 * A malformed column (an array, a nested object, a non-string value) is coerced
 * to an empty config rather than crashing the screen: the contract already
 * refused those on the way in, and a broken row must not take the connector list
 * down. Non-string values are dropped, never stringified — a value that is not a
 * string was never valid config here.
 */
function toConfig(value: unknown): Connection["config"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string") out[key] = raw;
  }
  return out;
}
