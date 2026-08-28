#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Compile the workspace to `dist/`, then point every manifest at it.
 *
 * This exists so the shipped image can contain JavaScript instead of
 * TypeScript. Until now the runtime executed `.ts` directly through `tsx`,
 * which meant the image had to carry the source — and `uguryldz/maestro-node`
 * is a PUBLIC repository, so "the image carries the source" and "the source is
 * published" were the same sentence.
 *
 * Two halves, and the second is the one that surprises people:
 *
 *  1. `tsc -p tsconfig.build.json` per package, in dependency order. Ordered
 *     because each package's `.d.ts` is the next one's input; building
 *     `@maestro/deploy` before `@maestro/contracts` would compile against
 *     types that do not exist yet.
 *
 *  2. Rewrite each `package.json`'s `exports` from `./src/*.ts` to
 *     `./dist/*.js`. pnpm resolves workspace packages through `exports`, so
 *     without this step every `@maestro/x` import inside the image would
 *     resolve straight back to the TypeScript that is no longer there.
 *
 * The rewrite is deliberately NOT committed to the repo. In a working tree the
 * manifests keep pointing at `src/`, so `pnpm typecheck`, `pnpm test` and
 * `tsx` all behave exactly as they did — no `dist/` needed, no stale build to
 * forget to refresh, no "works until you rebuild" class of bug. The rewrite
 * happens inside the Docker build, against a copy nobody edits. That is the
 * whole reason this is a script and not a patch to 26 manifests.
 */

const root = process.cwd();
const REWRITE = process.argv.includes("--rewrite-exports");

/** Read a manifest, tolerating the trailing-newline differences between them. */
function manifest(dir) {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
}

function workspaceDirs() {
  const out = [];
  for (const group of ["apps", "packages"]) {
    for (const name of readdirSync(join(root, group))) {
      const dir = join(root, group, name);
      if (existsSync(join(dir, "package.json"))) out.push(dir);
    }
  }
  return out;
}

const byName = new Map();
for (const dir of workspaceDirs()) {
  const m = manifest(dir);
  byName.set(m.name, { dir, m });
}

/**
 * What actually has to be compiled: the runtime closure of `@maestro/deploy`.
 *
 * Not "every workspace package". `@maestro/studio` is a Vite app with its own
 * image, and `demo`, `demo-stack`, `runner-agent`, `cache` and `test-kit` are
 * development or test-only — compiling them would add build time and image
 * weight for code the three entrypoints never import. The closure is computed
 * rather than listed because a hand-maintained list is the exact thing that
 * went stale in the `deps` stage of the Dockerfile and cost a debugging
 * session (see the comment there).
 */
function closure(rootName) {
  const seen = new Set();
  const order = [];
  function visit(name) {
    if (seen.has(name) || !byName.has(name)) return;
    seen.add(name);
    for (const dep of Object.keys(byName.get(name).m.dependencies ?? {})) visit(dep);
    order.push(name); // post-order: dependencies land before their dependents
  }
  visit(rootName);
  return order;
}

const order = closure("@maestro/deploy");

if (!REWRITE) {
  console.log(`[build] compiling ${String(order.length)} packages in dependency order`);
  for (const name of order) {
    const { dir } = byName.get(name);
    const cfg = join(dir, "tsconfig.build.json");
    if (!existsSync(cfg)) {
      console.log(`[build] ${name}: no tsconfig.build.json, skipping`);
      continue;
    }
    const started = Date.now();
    const r = spawnSync(process.execPath, [tscBin(), "-p", cfg], {
      stdio: "inherit",
      cwd: root,
    });
    if (r.status !== 0) {
      console.error(`[build] ${name}: FAILED`);
      process.exit(r.status ?? 1);
    }
    console.log(`[build] ${name} ok (${String(Date.now() - started)}ms)`);
  }
  console.log("[build] done");
}

/**
 * Point a manifest's entry fields at the compiled output.
 *
 * `exports` is rewritten by string substitution rather than by rebuilding the
 * map, because the shape varies: most packages export a single `"."`, and
 * `@maestro/pilot` also exports `"./state"`. Substitution handles both without
 * this script having to know which is which.
 *
 * `scripts` are dropped at the same time. The image has no `tsc` and no
 * `vitest`, so a `typecheck` or `test` script left behind is a command that
 * exists and cannot run — and `@maestro/db`'s `postinstall` would fire
 * `prisma generate` on every `pnpm install` in the runner stage, which the
 * Dockerfile runs deliberately and separately.
 */
if (REWRITE) {
  for (const name of order) {
    const { dir, m } = byName.get(name);
    const path = join(dir, "package.json");
    const next = { ...m };
    if (next.exports) {
      next.exports = JSON.parse(
        JSON.stringify(next.exports).replaceAll("./src/", "./dist/").replaceAll(".ts\"", ".js\""),
      );
    }
    // `scripts` go; `devDependencies` STAY.
    //
    // Dropping devDependencies looks like the tidy thing to do and breaks the
    // build: pnpm validates the lockfile against every manifest, so a manifest
    // with its devDependencies removed is "not up to date with pnpm-lock.yaml"
    // and `--frozen-lockfile` refuses to install. `--prod` already excludes
    // them from what actually lands in node_modules, which is the outcome the
    // deletion was reaching for anyway.
    delete next.scripts;
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
    console.log(`[build] rewrote ${name} -> dist`);
  }
}

function tscBin() {
  // Resolved from the workspace root, where `typescript` is a devDependency.
  return join(root, "node_modules", "typescript", "bin", "tsc");
}
