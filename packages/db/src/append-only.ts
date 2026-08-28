import type { Db } from "./client.js";

/**
 * Append-only surfaces for the two tables that may never be rewritten:
 * `JournalEntry` (M30) and `AuditLog` (M33).
 *
 * The database refuses UPDATE/DELETE outright (triggers, migration
 * `0002_append_only_and_guards`). That is the real guarantee — it holds for
 * psql and for code nobody has written yet. This module is the *second* line:
 * it makes the mistake un-typeable, so a `db.auditLog.deleteMany({})` fails at
 * `pnpm typecheck` instead of at runtime in production.
 *
 * Both halves are needed. A type alone would be advisory (a cast defeats it);
 * a trigger alone would let the mistake ship and only fail when it runs.
 */

/** The delegate methods an append-only table may expose. */
export const APPEND_ONLY_METHODS = [
  "create",
  "createMany",
  "findMany",
  "findFirst",
  "findUnique",
  "count",
  "aggregate",
  "groupBy",
] as const;

export type AppendOnlyMethod = (typeof APPEND_ONLY_METHODS)[number];

/** A Prisma delegate narrowed to the append-only methods. */
export type AppendOnlyDelegate<D> = Pick<D, Extract<keyof D, AppendOnlyMethod>>;

export interface AppendOnlyDb {
  readonly auditLog: AppendOnlyDelegate<Db["auditLog"]>;
  readonly journalEntry: AppendOnlyDelegate<Db["journalEntry"]>;
}

function narrow<D extends object>(delegate: D): AppendOnlyDelegate<D> {
  const surface: Record<string, unknown> = {};
  for (const method of APPEND_ONLY_METHODS) {
    const fn = (delegate as Record<string, unknown>)[method];
    if (typeof fn === "function") {
      surface[method] = (fn as (...args: unknown[]) => unknown).bind(delegate);
    }
  }
  // Frozen so the narrowing cannot be widened again by assignment.
  return Object.freeze(surface) as AppendOnlyDelegate<D>;
}

/**
 * Wrap a client in the append-only surface. The result is a *new* object that
 * carries only the permitted methods, so the mutating ones are unreachable at
 * runtime as well as in the type.
 */
export function appendOnly(db: Pick<Db, "auditLog" | "journalEntry">): AppendOnlyDb {
  return Object.freeze({
    auditLog: narrow(db.auditLog),
    journalEntry: narrow(db.journalEntry),
  });
}
