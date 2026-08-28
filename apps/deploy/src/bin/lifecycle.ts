import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Process lifecycle shared by the entrypoints.
 *
 * Two rules, both learned the expensive way:
 *
 *  - A boot failure exits NON-ZERO. A container that logs an error and then
 *    sits there with a closed port is a deployment that looks half-alive to an
 *    orchestrator, which will happily leave it in service.
 *  - A shutdown drains rather than exits. `SIGTERM` is what a rolling deploy
 *    sends, and dropping an in-flight webhook is a lost Jira delivery — Jira
 *    does not redeliver on Maestro's behalf.
 */

export const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/**
 * How long a drain may take before the process stops waiting.
 *
 * Long enough for an in-flight request, short enough to stay under the grace
 * period an orchestrator allows before it sends SIGKILL — a drain that outlasts
 * the grace period is not a drain, it is the same abrupt kill with extra steps.
 */
export const DRAIN_TIMEOUT_MS = 15_000;

export function install(drain: () => Promise<void>, process_: NodeJS.Process = process): void {
  let draining = false;
  const stop = (signal: string): void => {
    // A second Ctrl-C must not start a second drain over the first one.
    if (draining) return;
    draining = true;
    console.info(`[maestro] ${signal} received, draining`);
    withTimeout(drain(), DRAIN_TIMEOUT_MS)
      .then(() => process_.exit(0))
      .catch((error: unknown) => {
        console.error("[maestro] shutdown failed:", messageOf(error));
        process_.exit(1);
      });
  };
  for (const signal of SHUTDOWN_SIGNALS) process_.on(signal, () => stop(signal));
}

async function withTimeout(work: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`drain did not finish within ${ms}ms`)), ms);
    timer.unref();
  });
  try {
    await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Report a boot failure and exit non-zero.
 *
 * The message only — no `error.stack`, and never the error object itself. A
 * driver's failure can carry configuration in its frames, and a boot log is
 * the most widely readable artefact a deployment produces (this is the leak
 * the sandbox round found). The stack stays available to a debugger attached
 * to the process; it does not go to stdout.
 */
export function fail(error: unknown): never {
  console.error(`[maestro] startup failed: ${messageOf(error)}`);
  process.exit(1);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * True when this module is the process's entry file.
 *
 * The entrypoints run their `main()` at the top level, which is right for a
 * container and wrong for a test that wants to import one of their helpers —
 * the import alone would boot a server or start migrating. Comparing
 * `import.meta.url` against `process.argv[1]` distinguishes the two.
 */
export function isEntrypoint(moduleUrl: string, argv: readonly string[] = process.argv): boolean {
  const entry = argv[1];
  if (entry === undefined) return false;
  try {
    return fileURLToPath(moduleUrl) === resolve(entry);
  } catch {
    return false;
  }
}
