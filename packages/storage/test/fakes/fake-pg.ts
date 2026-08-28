import type { SqlExecutor } from "../../src/deps.js";

export interface FakePgRow {
  key: string;
  data: Buffer;
  content_type: string;
  tags: string;
  object_lock: boolean;
  retain_until: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * In-memory Postgres stand-in. It recognises only the statements the pg-blob
 * driver is supposed to issue and throws on anything else, so a changed or
 * malformed query fails the test instead of passing unnoticed.
 */
export class FakePg implements SqlExecutor {
  readonly rows = new Map<string, FakePgRow>();
  readonly statements: string[] = [];

  constructor(private readonly table = "storage_blob") {}

  query<R = Record<string, unknown>>(sql: string, params: readonly unknown[]): Promise<R[]> {
    this.statements.push(sql);
    const text = sql.replace(/\s+/g, " ").trim();
    if (text.startsWith(`INSERT INTO ${this.table} `)) return ok(this.insert(text, params));
    if (text === `SELECT data FROM ${this.table} WHERE key = $1`) {
      return ok(this.selectColumns(params, ["data"]));
    }
    if (text === `SELECT object_lock, retain_until FROM ${this.table} WHERE key = $1`) {
      return ok(this.selectColumns(params, ["object_lock", "retain_until"]));
    }
    if (text === `SELECT key FROM ${this.table} WHERE key LIKE $1 ORDER BY key ASC`) {
      return ok(this.selectLike(params));
    }
    if (text === `DELETE FROM ${this.table} WHERE key = $1`) {
      this.rows.delete(stringParam(params, 0));
      return ok([]);
    }
    throw new Error(`FakePg: unrecognised statement: ${text}`);
  }

  private insert(text: string, params: readonly unknown[]): never[] {
    if (!text.includes("ON CONFLICT (key) DO UPDATE")) {
      throw new Error("FakePg: insert must be an upsert on the key");
    }
    // WORM columns are merged, never replaced: an unlocked put may not clear the
    // retention a previous locked put established (M57).
    if (!/object_lock = \(\w+\.object_lock OR EXCLUDED\.object_lock\)/.test(text)) {
      throw new Error("FakePg: upsert must preserve an existing object_lock");
    }
    if (!/retain_until = GREATEST\(\w+\.retain_until, EXCLUDED\.retain_until\)/.test(text)) {
      throw new Error("FakePg: upsert must preserve the longest retain_until");
    }
    if (params.length !== 7) throw new Error(`FakePg: expected 7 insert params, got ${params.length}`);
    const key = stringParam(params, 0);
    const data = params[1];
    // node-postgres writes a bare Uint8Array as a JSON object, silently
    // corrupting the blob; only a Buffer reaches bytea intact.
    if (!Buffer.isBuffer(data)) {
      throw new Error("FakePg: $2 must be a node Buffer for a bytea column");
    }
    const at = stringParam(params, 6);
    const previous = this.rows.get(key);
    const retainUntil = params[5] === null ? null : stringParam(params, 5);
    this.rows.set(key, {
      key,
      data: Buffer.from(data),
      content_type: stringParam(params, 2),
      tags: stringParam(params, 3),
      object_lock: previous?.object_lock === true || params[4] === true,
      retain_until: greatest(previous?.retain_until ?? null, retainUntil),
      created_at: previous?.created_at ?? at,
      updated_at: at,
    });
    return [];
  }

  private selectColumns(params: readonly unknown[], columns: (keyof FakePgRow)[]): unknown[] {
    const row = this.rows.get(stringParam(params, 0));
    if (!row) return [];
    return [Object.fromEntries(columns.map((c) => [c, row[c]]))];
  }

  private selectLike(params: readonly unknown[]): { key: string }[] {
    const pattern = stringParam(params, 0);
    if (!pattern.endsWith("%")) throw new Error("FakePg: prefix search must end with %");
    const literal = pattern.slice(0, -1).replace(/\\([\\%_])/g, "$1");
    return [...this.rows.keys()]
      .filter((key) => key.startsWith(literal))
      .sort()
      .map((key) => ({ key }));
  }
}

/** Postgres GREATEST ignores NULL operands and returns NULL only if all are NULL. */
function greatest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function stringParam(params: readonly unknown[], index: number): string {
  const value = params[index];
  if (typeof value !== "string") throw new Error(`FakePg: $${index + 1} must be a string`);
  return value;
}

function ok<T, R>(rows: T[]): Promise<R[]> {
  return Promise.resolve(rows as unknown as R[]);
}
