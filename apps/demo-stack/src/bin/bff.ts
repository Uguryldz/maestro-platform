import { buildServer } from "@maestro/bff";
import { t } from "@maestro/config";
import { listenAddress } from "../address.js";
import { bannerLines } from "../banner.js";
import { buildDemoStack } from "../deps.js";
import { fail, install, isEntrypoint } from "./lifecycle.js";

/**
 * The demo BFF process.
 *
 * Boot order mirrors `apps/deploy/src/bin/bff.ts` — build the container, build
 * the server, listen last — minus every step that needs something running:
 * there is no database to connect, no Temporal to reach, no secret to resolve.
 * Listening still comes last, because the shape of the boot is part of what the
 * demo is showing.
 */

export async function main(): Promise<void> {
  const stack = await buildDemoStack();
  const app = await buildServer(stack.deps);

  const { host, port } = listenAddress();
  await app.listen({ host, port });

  // The banner is the first half of "the user can see this is a demo". The
  // second half is on screen: the health rows carry `demo.stack.note`, which
  // Studio renders through the catalog. Both come from the SAME catalog keys —
  // there is no hardcoded sentence in this process announcing itself.
  for (const line of bannerLines(t, stack.summary, { host, port })) console.info(line);

  install(async () => {
    await app.close();
  });
}

if (isEntrypoint(import.meta.url)) {
  await main().catch(fail);
}
