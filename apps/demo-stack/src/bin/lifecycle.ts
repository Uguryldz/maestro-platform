import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Process lifecycle for the demo entrypoints, following the same two rules as
 * `apps/deploy/src/bin/lifecycle.ts`: a boot failure exits NON-ZERO, and a
 * shutdown drains rather than exits.
 *
 * Written here rather than imported because `@maestro/deploy` does not export
 * it, and reaching into another app's `src/bin` would make this package depend
 * on the composition root's internals — the demo is a SIBLING of the deployment,
 * not a layer on top of it.
 */

export const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;
export const DRAIN_TIMEOUT_MS = 15_000;

export function install(drain: () => Promise<void>, process_: NodeJS.Process = process): void {
  let draining = false;
  const stop = (signal: string): void => {
    // A second Ctrl-C must not start a second drain over the first one.
    if (draining) return;
    draining = true;
    console.info(`[demo] ${signal} alındı, kapanıyor`);
    withTimeout(drain(), DRAIN_TIMEOUT_MS)
      .then(() => process_.exit(0))
      .catch((error: unknown) => {
        console.error(`[demo] kapanış hatası: ${messageOf(error)}`);
        process_.exit(1);
      });
  };
  for (const signal of SHUTDOWN_SIGNALS) process_.on(signal, () => stop(signal));
}

async function withTimeout(work: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`kapanış ${ms}ms içinde tamamlanmadı`)), ms);
    timer.unref();
  });
  try {
    await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The message only — never the stack: a boot log is the most widely read artefact. */
export function fail(error: unknown): never {
  console.error(`[demo] başlatma hatası: ${messageOf(error)}`);
  process.exit(1);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when this module is the process's entry file. */
export function isEntrypoint(moduleUrl: string, argv: readonly string[] = process.argv): boolean {
  const entry = argv[1];
  if (entry === undefined) return false;
  try {
    return fileURLToPath(moduleUrl) === resolve(entry);
  } catch {
    return false;
  }
}
