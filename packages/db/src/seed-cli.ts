import { createDb } from "./client.js";
import { seedParams } from "./seed.js";
import { seedDemo } from "./seed-demo.js";
import { resetRuntimeData } from "./reset.js";

/**
 * Seed / maintenance runner: `pnpm -F @maestro/db seed [flags]`.
 *
 * Needs a reachable database, so it is not part of the offline test suite —
 * the data it writes is, though (see test/seed.test.ts and test/seed-demo.test.ts).
 *
 * Default behaviour is PROD-SAFE: it seeds only what the platform genuinely
 * needs to function (parameter definitions). The UGURPAY demo fixture — 22 fake
 * tickets, apps, routing rules — is opt-in behind `--demo` (or `SEED_DEMO=1`),
 * because a real deployment must show only real work, never the demo.
 *
 * Flags:
 *   --demo         also load the demo fixture (off by default). `SEED_DEMO=1` too.
 *   --params-only  legacy alias for the default (params only); kept for scripts.
 *   --reset --yes  TRUNCATE run/demo tables, KEEP users/params/templates/login.
 */
export async function runSeedCli(
  env: Record<string, string | undefined>,
  argv: readonly string[] = [],
): Promise<void> {
  const url = env["DATABASE_URL"];
  if (url === undefined || url.trim().length === 0) {
    throw new Error("DATABASE_URL is required to run the seed");
  }

  const wantReset = argv.includes("--reset");
  // Demo is opt-in: only an explicit flag or env switch loads it. `--params-only`
  // is now redundant (params-only is the default) but stays so old scripts pass.
  const wantDemo = argv.includes("--demo") || env["SEED_DEMO"] === "1";

  const db = createDb(url);
  try {
    if (wantReset) {
      if (!argv.includes("--yes")) {
        throw new Error(
          "refusing to reset without confirmation — re-run with: --reset --yes",
        );
      }
      const purgeAudit = argv.includes("--purge-audit");
      const cleared = await resetRuntimeData(db, { purgeAudit });
      for (const [table, count] of Object.entries(cleared)) {
        console.log(`cleared ${count} ${table}`);
      }
      return;
    }

    const params = await seedParams(db);
    console.log(`seeded ${params.definitions} parameter definitions`);

    if (!wantDemo) {
      console.log("demo fixture skipped (default); pass --demo or SEED_DEMO=1 to load it");
      return;
    }
    const counts = await seedDemo(db);
    for (const [table, count] of Object.entries(counts)) {
      console.log(`seeded ${count} ${table}`);
    }
  } finally {
    await db.$disconnect();
  }
}

await runSeedCli(process.env, process.argv.slice(2));
