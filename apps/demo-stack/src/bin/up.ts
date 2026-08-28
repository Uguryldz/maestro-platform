import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildServer } from "@maestro/bff";
import { t } from "@maestro/config";
import { bannerLines } from "../banner.js";
import { buildDemoStack } from "../deps.js";
import { listenAddress } from "../address.js";
import { fail, install, isEntrypoint } from "./lifecycle.js";

/**
 * `pnpm demo:up` — the whole stack in one process tree.
 *
 * The BFF runs IN this process rather than as a child: it is a Fastify server
 * built from an in-memory container, so there is nothing to wait for and no
 * second process to keep alive. Studio is a child, because Vite owns its own
 * dev server and proxy (`/api` → 7001 is already in `vite.config.ts`).
 *
 * Ordering is the point of this file. The BFF listens BEFORE Vite is spawned, so
 * the first request Studio's browser makes cannot land on a closed port and show
 * a network error that looks like a bug in the demo.
 */

const STUDIO_DIR = fileURLToPath(new URL("../../../studio", import.meta.url));

export async function main(): Promise<void> {
  const stack = await buildDemoStack();
  const app = await buildServer(stack.deps);

  const { host, port } = listenAddress();
  await app.listen({ host, port });

  for (const line of bannerLines(t, stack.summary, { host, port })) console.info(line);

  const studio = startStudio(port);

  install(async () => {
    // Studio first: killing the API out from under a live page would paint a
    // wall of failed requests on the way down.
    stopStudio(studio);
    await app.close();
  });
}

/**
 * Vite, on 7000. `MAESTRO_BFF_ORIGIN` is what `vite.config.ts` reads for its
 * `/api` proxy target, so the demo's port choice reaches the proxy without
 * anyone editing Studio's config.
 */
function startStudio(bffPort: number): ChildProcess {
  const child = spawn("pnpm", ["run", "dev"], {
    cwd: STUDIO_DIR,
    stdio: "inherit",
    env: { ...process.env, MAESTRO_BFF_ORIGIN: `http://127.0.0.1:${bffPort}` },
  });

  child.on("error", (error) => {
    console.error(`[demo] Studio başlatılamadı: ${error.message}`);
  });
  // A Vite that dies is not something to survive quietly: the demo is the two
  // halves together, and a lone API on 7001 is not what anybody asked to see.
  child.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`[demo] Studio ${code} koduyla kapandı`);
    }
  });
  return child;
}

function stopStudio(child: ChildProcess): void {
  if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
}

if (isEntrypoint(import.meta.url)) {
  await main().catch(fail);
}
