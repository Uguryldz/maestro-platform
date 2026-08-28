import { createServer, type Server } from "node:http";

/**
 * A liveness endpoint for the worker, so the container can be restarted when it
 * stops being able to do the job.
 *
 * The worker serves no HTTP of its own, so its compose healthcheck was
 * `["NONE"]` and the only thing keeping it alive was `restart: unless-stopped`
 * — which reacts to the PROCESS dying. That is the wrong signal for this
 * process: the failure that actually strands an installation is the worker
 * staying up while it can no longer take work. The Temporal connection drops
 * and the SDK's reconnect never succeeds, or the poller wedges; the process is
 * healthy by every measure Docker can see, the queue fills, and the analysis
 * "never finishes" with nothing in the logs after the last successful run.
 *
 * So this answers the only question worth asking of a worker: is it polling?
 * `ready` is written by the caller once the Temporal worker reaches RUNNING and
 * cleared when it stops for any reason, so a wedged worker reports 503.
 *
 * The 503 is what the `autoheal` service acts on (`bin/autoheal.ts`). Compose
 * itself does NOT restart on health status — `restart: unless-stopped` reacts
 * only to the process exiting — so without that sidecar this probe would be
 * observability and nothing more. It is deliberately NOT a Temporal round-trip: a
 * probe that talked to the server would restart the worker for the SERVER's
 * outage, which is the one thing a restart cannot fix.
 *
 * Failing to bind is not fatal. A worker that cannot open a health port is
 * still a worker that runs analyses, and refusing to start over a probe would
 * turn a monitoring gap into an outage.
 */

export interface WorkerLiveness {
  /** Mark the worker as polling — or not. */
  setReady(ready: boolean): void;
  close(): Promise<void>;
}

/** Off when unset: a deployment that does not ask for the probe does not get a port. */
export const WORKER_HEALTH_PORT_VAR = "WORKER_HEALTH_PORT";

export function startWorkerLiveness(options: {
  readonly port: number;
  readonly host?: string;
  readonly log?: (message: string) => void;
}): WorkerLiveness {
  const log = options.log ?? ((message: string): void => console.warn(message));
  let ready = false;
  let server: Server | null = null;

  try {
    server = createServer((request, response) => {
      // One path, and everything else is a 404: this is a probe, not an API.
      if (request.url !== "/healthz") {
        response.writeHead(404).end();
        return;
      }
      const body = JSON.stringify({ status: ready ? "ok" : "starting", polling: ready });
      response
        .writeHead(ready ? 200 : 503, {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        })
        .end(body);
    });
    server.on("error", (error: Error) => {
      log(`[maestro] worker: sağlık ucu açılamadı, worker çalışmaya devam ediyor — ${error.message}`);
      server = null;
    });
    // The health port must never hold the process open on its own: when the
    // worker drains and exits, an un-unref'd listener would keep the container
    // alive as a shell that answers 503 forever.
    server.listen(options.port, options.host ?? "0.0.0.0");
    server.unref();
  } catch (error) {
    log(
      `[maestro] worker: sağlık ucu açılamadı, worker çalışmaya devam ediyor — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    server = null;
  }

  return {
    setReady: (value: boolean): void => {
      ready = value;
    },
    close: (): Promise<void> =>
      new Promise((resolve) => {
        if (server === null) {
          resolve();
          return;
        }
        server.close(() => resolve());
      }),
  };
}

/**
 * The port to serve the probe on, or null when the deployment did not ask.
 *
 * An unparseable or out-of-range value is treated as "not asked" rather than
 * refused: the worker's job is analyses, and a typo in a monitoring variable
 * must not be the reason a bank has no delivery. It is logged by the caller.
 */
export function healthPortOf(source: Record<string, string | undefined>): number | null {
  const raw = source[WORKER_HEALTH_PORT_VAR]?.trim();
  if (raw === undefined || raw === "") return null;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}
