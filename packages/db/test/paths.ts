import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GUARDS_MIGRATION_RELATIVE_PATH,
  INITIAL_MIGRATION_RELATIVE_PATH,
  PRISMA_SCHEMA_RELATIVE_PATH,
} from "../src/index.js";

/** Absolute path of the `@maestro/db` package root. */
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const SCHEMA_PATH = join(PACKAGE_ROOT, PRISMA_SCHEMA_RELATIVE_PATH);
export const MIGRATION_PATH = join(PACKAGE_ROOT, INITIAL_MIGRATION_RELATIVE_PATH);
export const GUARDS_MIGRATION_PATH = join(PACKAGE_ROOT, GUARDS_MIGRATION_RELATIVE_PATH);
export const MIGRATION_LOCK_PATH = join(PACKAGE_ROOT, "prisma/migrations/migration_lock.toml");

export function readSchema(): string {
  return readFileSync(SCHEMA_PATH, "utf8");
}

export function readMigration(): string {
  return readFileSync(MIGRATION_PATH, "utf8");
}

export function readGuardsMigration(): string {
  return readFileSync(GUARDS_MIGRATION_PATH, "utf8");
}

/**
 * ONE migration's SQL, by directory name. `allMigrationSql()` is the right tool
 * for drift ("does the schema reach the database at all"), but a hand-written
 * migration also has properties that only hold WITHIN its own file — "0018 adds
 * a column and touches nothing else" is false of the concatenation, where every
 * earlier CREATE TABLE is in scope. Those assertions need the file alone.
 */
export function readMigrationNamed(name: string): string {
  return readFileSync(join(PACKAGE_ROOT, "prisma", "migrations", name, "migration.sql"), "utf8");
}

/**
 * Every migration's SQL, in order. Drift guards read this rather than only the
 * initial migration: a type added in 0003 is not drift, it is history.
 */
export function allMigrationSql(): string {
  const root = join(PACKAGE_ROOT, "prisma", "migrations");
  return readdirSync(root)
    .filter((entry) => /^\d+_/.test(entry))
    .sort()
    .map((entry) => readFileSync(join(root, entry, "migration.sql"), "utf8"))
    .join("\n");
}
