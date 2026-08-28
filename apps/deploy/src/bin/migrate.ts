import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import {
  assertPostgresUrl,
  createDb,
  DEFAULT_VARIANT_MODEL,
  firstAdminDbOf,
  PRISMA_SCHEMA_RELATIVE_PATH,
  seedAnalysisTemplate,
  seedDefaultVariants,
  seedFirstAdmin,
} from "@maestro/db";
import { BcryptPasswordHasher } from "@maestro/bff";
import { loadDeployEnv } from "../env.js";
import { fail, isEntrypoint } from "./lifecycle.js";

/**
 * Apply the schema, exactly once, whoever starts first.
 *
 * Every service container runs this before its own entrypoint, which means N
 * replicas can reach it at the same moment. `prisma migrate deploy` is not
 * safe to run concurrently — two processes applying the same migration race on
 * the `_prisma_migrations` bookkeeping and can leave it marked failed — so the
 * run is serialised behind a Postgres ADVISORY lock.
 *
 * An advisory lock rather than a table: it is held by the SESSION and released
 * when the connection drops, so a container killed mid-migration cannot leave
 * the lock held forever. A lock row in a table would need a lease, a clock and
 * a recovery path; the database already solved this.
 */

/**
 * Lock id. Any constant works as long as every replica agrees on it; this one
 * is a fixed arbitrary value chosen to be unlikely to collide with an
 * application's own advisory locks in a shared database.
 */
export const MIGRATION_LOCK_ID = 8_274_591_003_112n;

/** How long to wait for the holder before giving up. */
export const LOCK_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;

export async function main(): Promise<void> {
  const env = loadDeployEnv();
  const url = env.base.DATABASE_URL;
  if (url === undefined) {
    throw new Error("DATABASE_URL: required to apply migrations (M6)");
  }
  assertPostgresUrl(url);

  const db = createDb(url);
  try {
    const acquired = await acquireLock(db);
    if (!acquired) {
      throw new Error(
        `migrate: another process has held the migration lock for more than ${LOCK_TIMEOUT_MS}ms — ` +
          "not applying migrations concurrently",
      );
    }
    console.info("[maestro] migration lock acquired, applying migrations");
    await runPrismaDeploy(url);
    console.info("[maestro] migrations applied");

    /**
     * Publish version 1 of the analysis template if nobody has published one.
     *
     * Here rather than in the seed CLI because this is the path EVERY
     * deployment runs — the seed CLI is opt-in and the demo half of it must
     * never touch a bank's database. Inside the advisory lock for the same
     * reason the migration is: N replicas start at once, and this writes.
     *
     * A platform with no template answers `GET /template` with 404 and renders
     * a designer screen that says "henüz yayında değil", which is what a pilot
     * team saw. Seeding is skipped the moment a template exists, so a bank on
     * version 4 stays on version 4 (M83).
     */
    const template = await seedAnalysisTemplate(db);
    console.info(
      template.seeded
        ? `[maestro] analysis template v1 published (${String(template.sections)} sections)`
        : "[maestro] analysis template already published, leaving it alone",
    );

    /**
     * Plant the first-run bootstrap admin if this install has no admin yet.
     *
     * Here, inside the advisory lock, for the same reasons the template seed is:
     * this is the path EVERY deployment runs (the seed CLI is opt-in and its
     * demo half must never touch a bank's database), and N replicas start at
     * once. A fresh clean install would otherwise have no account anyone could
     * log in with — nobody could reach the screen that creates the first real
     * user. The password is GENERATED (packages/db/src/bootstrap-password.ts)
     * and printed below EXACTLY ONCE — install.sh runs this container in the
     * operator's terminal, so the one printing lands in front of the one person
     * who needs it. The account is FORCED to change it on first login (M8,
     * banking standard). The moment a real admin exists — including the
     * bootstrap admin after they have changed their password — this is a no-op
     * and never resets or re-prints the credential.
     *
     * `MAESTRO_BOOTSTRAP_PASSWORD` (env, optional) lets a dev stack or a
     * runbook choose the initial credential instead; the password is then NOT
     * printed (whoever set the variable already knows it) and the forced
     * first-login change still applies.
     */
    const bootstrapHasher = new BcryptPasswordHasher();
    const suppliedBootstrapPassword = process.env["MAESTRO_BOOTSTRAP_PASSWORD"]?.trim();
    const admin = await seedFirstAdmin(
      firstAdminDbOf(db),
      (password) => bootstrapHasher.hash(password),
      suppliedBootstrapPassword ? { password: suppliedBootstrapPassword } : undefined,
    );
    if (!admin.seeded) {
      console.info("[maestro] an admin account already exists, leaving the bootstrap seed alone");
    } else if (suppliedBootstrapPassword) {
      console.info(
        "[maestro] first-run admin planted (admin) — password from MAESTRO_BOOTSTRAP_PASSWORD, change forced on first login",
      );
    } else {
      // Turkish on purpose: these five lines are the hand-over of the only
      // credential a fresh install has, and the operator reading them is the
      // same person install.sh talks to in Turkish.
      console.info("[maestro] ─────────────────────────────────────────────────────────────");
      console.info("[maestro] İLK KURULUM: 'admin' yönetici hesabı oluşturuldu.");
      console.info(`[maestro] GEÇİCİ PAROLA (yalnızca bu satırda gösterilir): ${admin.password}`);
      console.info("[maestro] İlk girişte sistem yeni bir parola belirlemenizi ZORUNLU tutar.");
      console.info("[maestro] Parola kaybolursa: sunucuda ./reset-admin.sh admin  (bkz. README).");
      console.info("[maestro] ─────────────────────────────────────────────────────────────");
    }

    /**
     * Plant the default agent variants if this install has none (M38).
     *
     * Here, inside the same advisory lock and on the same every-deploy path as
     * the template and admin seeds. A fresh clean install has no variant rows,
     * so `/variants` renders empty and the pilot has no DB record to resolve its
     * model from. This gives it one `analyst` and one `engineer` variant, whose
     * version-1 model is the BOOTSTRAP `PILOT_MODEL` (env) — the only place env
     * feeds a variant. From then on the admin re-versions them from Studio and
     * env is never read at flow time. Idempotent and non-clobbering per id: a
     * bank whose admin has already re-versioned a variant keeps it (M83).
     */
    const bootstrapModel = process.env["PILOT_MODEL"]?.trim() || DEFAULT_VARIANT_MODEL;
    const variants = await seedDefaultVariants(db, { model: bootstrapModel });
    console.info(
      variants.seeded.length > 0
        ? `[maestro] default agent variants planted (${variants.seeded.join(", ")}) on model ${bootstrapModel}`
        : "[maestro] agent variants already exist, leaving them alone",
    );
  } finally {
    // Releasing explicitly rather than relying on disconnect keeps the window
    // short when the client is pooled; `$disconnect` would do it anyway.
    await releaseLock(db);
    await db.$disconnect();
  }
}

/**
 * `pg_try_advisory_lock` in a poll loop rather than the blocking
 * `pg_advisory_lock`: a blocking call would hang forever behind a wedged
 * holder, and a container that hangs forever never reports anything. Polling
 * turns that into a timeout with a message.
 */
export async function acquireLock(
  db: { $queryRawUnsafe: (sql: string) => Promise<unknown> },
  timeoutMs: number = LOCK_TIMEOUT_MS,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await db.$queryRawUnsafe(`SELECT pg_try_advisory_lock(${MIGRATION_LOCK_ID}) AS locked`);
    if (firstBoolean(rows)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(POLL_INTERVAL_MS);
  }
}

export async function releaseLock(db: {
  $queryRawUnsafe: (sql: string) => Promise<unknown>;
}): Promise<void> {
  // A failure to release is not worth failing the process over: the session is
  // about to close, which releases it regardless.
  try {
    await db.$queryRawUnsafe(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_ID})`);
  } catch {
    /* released on disconnect */
  }
}

function firstBoolean(rows: unknown): boolean {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  const first: unknown = rows[0];
  if (typeof first !== "object" || first === null) return false;
  return Object.values(first as Record<string, unknown>)[0] === true;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve_) => setTimeout(resolve_, ms));
}

/**
 * `prisma migrate deploy` — the deploy-time command, not `migrate dev`.
 *
 * `deploy` applies committed migrations and nothing else: it never generates a
 * migration, never resets, and refuses a drifted database instead of "fixing"
 * it. That refusal is the behaviour worth having in a bank; `migrate dev`
 * would offer to drop the schema.
 *
 * `DATABASE_URL` is passed through the child's environment because that is
 * where Prisma reads it from — never on the command line, where it would be
 * visible in `ps` to every user on the host.
 */
export function runPrismaDeploy(url: string): Promise<void> {
  const schemaPath = resolveSchemaPath();
  return new Promise((resolve_, reject) => {
    const child = spawn(
      process.execPath,
      [prismaBin(), "migrate", "deploy", "--schema", schemaPath],
      { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, DATABASE_URL: url } },
    );
    child.on("error", (error) => reject(new Error(`prisma could not be started: ${error.message}`)));
    child.on("exit", (code) => {
      if (code === 0) resolve_();
      else reject(new Error(`prisma migrate deploy exited with code ${code ?? "unknown"}`));
    });
  });
}

const require_ = createRequire(import.meta.url);

/**
 * The schema inside `@maestro/db`, found through the package rather than by a
 * relative path out of this file.
 *
 * Resolved from the package's ENTRY point (`src/index.ts`) rather than from its
 * `package.json`: the manifest is not in the package's `exports` map, so asking
 * for it throws. The entry sits at `<pkg>/src/index.ts`, so the package root is
 * two directories up — and `PRISMA_SCHEMA_RELATIVE_PATH` is the package's own
 * constant for the rest, which keeps this in step if the schema ever moves.
 */
export function resolveSchemaPath(): string {
  const entry = require_.resolve("@maestro/db");
  return resolve(dirname(entry), "..", PRISMA_SCHEMA_RELATIVE_PATH);
}

/**
 * The Prisma CLI, resolved FROM `@maestro/db` rather than from this file.
 *
 * pnpm gives each workspace package its own `node_modules`, and `prisma` is a
 * dependency of `@maestro/db` — not of this app. Resolving it from here works
 * on a developer's machine, where the root store happens to hoist it, and
 * fails inside the image, where it does not: the migration container exited 1
 * with "Cannot find module 'prisma/build/index.js'" while the binary sat in
 * `packages/db/node_modules/prisma`. Resolving through the package that
 * actually declares it works in both places, and is the same trick
 * `schemaPath()` above already uses for the schema.
 */
function prismaBin(): string {
  const dbEntry = require_.resolve("@maestro/db");
  return createRequire(dbEntry).resolve("prisma/build/index.js");
}

// Only when this file IS the process, not when a test imports it for the lock
// helpers. Without the guard, importing this module would try to migrate.
if (isEntrypoint(import.meta.url)) {
  await main().catch(fail);
}
