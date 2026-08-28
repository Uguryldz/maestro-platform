/**
 * Injected runtime collaborators. Everything a driver cannot compute itself —
 * network, wall clock, database — arrives through these so the whole package
 * stays deterministic and fully offline in tests (insa-plani §2.3).
 */

export interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * Narrowed `fetch`. The platform `fetch` (or a corporate egress-proxy wrapper
 * around it) is assignable to this type; test doubles implement it directly.
 */
export type FetchLike = (url: string, init: FetchInit) => Promise<Response>;

/** Wall clock. Injected so retention deadlines are reproducible. */
export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

/**
 * Minimal SQL surface the pg-blob driver needs.
 *
 * Deliberately NOT `@maestro/db`'s Prisma client: (1) Wave 0 ships only a draft
 * schema with no generated client, so importing it would make this package
 * un-typecheckable until `prisma generate` has run; (2) a generated client
 * cannot be faked offline, which would push every pg-blob test onto a live
 * database and break the "deterministic, no network" rule. A one-line adapter
 * over `prisma.$queryRawUnsafe` or a `pg` Pool satisfies this interface at the
 * composition root.
 *
 * **Binary contract.** Parameters bound to a `bytea` column are node `Buffer`s
 * and the adapter must pass them through untouched. `node-postgres` decides how
 * to serialise a value with `Buffer.isBuffer`, and a plain `Uint8Array` is not a
 * Buffer: it would be written as `{"0":72,…}` and the evidence would be
 * corrupted without a single error. Rows come back with `bytea` as a Buffer.
 */
export interface SqlExecutor {
  query<R = Record<string, unknown>>(sql: string, params: readonly unknown[]): Promise<R[]>;
}
