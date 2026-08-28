/**
 * Restart the containers of THIS stack when Docker marks them unhealthy.
 *
 * Docker Compose does not do this. `restart: unless-stopped` reacts to a
 * process EXITING, and the failure that strands an analysis install is the
 * opposite one: the worker alive but no longer polling — its Temporal
 * connection dropped and never came back, or the poller wedged. The healthcheck
 * sees it (`worker-liveness.ts` answers 503), Docker writes `unhealthy` next to
 * the container, and then nothing happens. Forever. The queue fills, the log
 * stays silent after the last good run, and the analysis "never finishes".
 *
 * So this closes the loop: watch Docker's event stream, and when a container of
 * this project goes unhealthy, restart it.
 *
 * SCOPE IS THE POINT. It restarts only containers carrying this compose
 * project's label, so a process with access to the daemon socket cannot be
 * talked into bouncing something else on the host. It also never CREATES,
 * removes or reconfigures anything — restart is the only verb it knows.
 *
 * It runs from the same image as every other Node service, deliberately: an
 * air-gapped bank mirrors five images already, and a sixth one for ten lines of
 * code is a sixth thing to get wrong on the day of the install.
 */
import { request } from "node:http";
import { isEntrypoint } from "./lifecycle.js";

/** Docker's API socket, mounted read-only into this container. */
const SOCKET = process.env["DOCKER_SOCKET_PATH"] ?? "/var/run/docker.sock";

/**
 * The compose project whose containers may be restarted.
 *
 * Required, with no default. A blank value would widen the filter to EVERY
 * container on the host, which is the one behaviour this must never have — so
 * an unset variable stops the process rather than quietly becoming a
 * host-wide restarter.
 */
const PROJECT_LABEL = "com.docker.compose.project";

/** How long to wait before reconnecting to the event stream. */
const RECONNECT_MS = 5_000;

/**
 * How long Docker may take to stop a container before it is killed, and how
 * long this waits for the whole restart to come back.
 *
 * The two must not be equal. They were — 30s each — and the result was
 * measured live: the worker drains for its full grace period, Docker answers
 * only after the container is up again, and the request timed out one instant
 * before the reply. The restart SUCCEEDED and the log said it had failed,
 * which is the worst kind of wrong: an operator reading it would go looking
 * for a broken autohealer that works.
 */
const STOP_GRACE_S = 30;
const RESTART_TIMEOUT_MS = (STOP_GRACE_S + 30) * 1_000;

export interface AutohealOptions {
  readonly project: string;
  readonly socketPath?: string;
  readonly log?: (message: string) => void;
  /** Test seam: resolves when the caller wants the loop to stop. */
  readonly until?: Promise<void>;
}

/** One Docker API call over the socket. Resolves with the raw body. */
function dockerRequest(
  socketPath: string,
  path: string,
  method: "GET" | "POST",
  timeoutMs = 30_000,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const call = request({ socketPath, path, method, timeout: timeoutMs }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    call.on("error", reject);
    call.on("timeout", () => call.destroy(new Error("docker: istek zaman aşımına uğradı")));
    call.end();
  });
}

/**
 * Restart one container by id.
 *
 * A failure here is logged and swallowed: the next unhealthy event will try
 * again, and an autohealer that dies on a transient daemon error is an
 * autohealer that is not there when it is needed.
 */
async function restart(
  socketPath: string,
  id: string,
  name: string,
  log: (message: string) => void,
): Promise<void> {
  try {
    const result = await dockerRequest(
      socketPath,
      `/containers/${id}/restart?t=${STOP_GRACE_S}`,
      "POST",
      RESTART_TIMEOUT_MS,
    );
    log(
      result.status >= 200 && result.status < 300
        ? `[maestro] autoheal: ${name} sağlıksız işaretlendi — yeniden başlatıldı`
        : `[maestro] autoheal: ${name} yeniden başlatılamadı (HTTP ${result.status}) — sonraki olayda yeniden denenecek`,
    );
  } catch (error) {
    log(
      `[maestro] autoheal: ${name} yeniden başlatılamadı — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Restart anything that is ALREADY unhealthy when this starts.
 *
 * Docker emits `health_status: unhealthy` on the TRANSITION only. A container
 * that went unhealthy before this process started — or while it was being
 * restarted itself — never produces another event, so watching alone would
 * leave it wedged forever: exactly the state the autohealer exists to end, and
 * the one it would be blind to on every deploy.
 */
export async function sweepUnhealthy(options: AutohealOptions): Promise<number> {
  const socketPath = options.socketPath ?? SOCKET;
  const log = options.log ?? ((message: string): void => console.info(message));
  const filters = encodeURIComponent(
    JSON.stringify({
      health: ["unhealthy"],
      label: [`${PROJECT_LABEL}=${options.project}`],
    }),
  );
  let containers: Array<{ Id?: string; Names?: string[] }> = [];
  try {
    const result = await dockerRequest(socketPath, `/containers/json?filters=${filters}`, "GET");
    if (result.status < 200 || result.status >= 300) {
      log(`[maestro] autoheal: açılış taraması yapılamadı (HTTP ${result.status})`);
      return 0;
    }
    containers = JSON.parse(result.body) as typeof containers;
  } catch (error) {
    log(
      `[maestro] autoheal: açılış taraması yapılamadı — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 0;
  }
  for (const container of containers) {
    const id = container.Id;
    if (typeof id !== "string" || id === "") continue;
    await restart(socketPath, id, container.Names?.[0]?.replace(/^\//u, "") ?? id.slice(0, 12), log);
  }
  return containers.length;
}

/**
 * Watch the event stream until `until` resolves.
 *
 * The filter is applied by DOCKER, not here: only `health_status: unhealthy`
 * events for containers of this project ever arrive, so a malformed line can
 * never widen the scope by accident.
 */
export async function watchUnhealthy(options: AutohealOptions): Promise<void> {
  const socketPath = options.socketPath ?? SOCKET;
  const log = options.log ?? ((message: string): void => console.info(message));
  const filters = encodeURIComponent(
    JSON.stringify({
      type: ["container"],
      event: ["health_status: unhealthy"],
      label: [`${PROJECT_LABEL}=${options.project}`],
    }),
  );

  let stopped = false;
  void options.until?.then(() => (stopped = true));

  while (!stopped) {
    await new Promise<void>((resolve) => {
      const call = request(
        { socketPath, path: `/events?filters=${filters}`, method: "GET" },
        (response) => {
          response.setEncoding("utf8");
          let buffer = "";
          response.on("data", (chunk: string) => {
            buffer += chunk;
            // Docker streams newline-delimited JSON; a chunk may split a line.
            for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
              const line = buffer.slice(0, nl).trim();
              buffer = buffer.slice(nl + 1);
              if (line === "") continue;
              try {
                const event = JSON.parse(line) as {
                  id?: string;
                  Actor?: { ID?: string; Attributes?: Record<string, string> };
                };
                /**
                 * `Actor.ID` first, lower-case `id` second.
                 *
                 * Measured against Docker 29: the modern event carries the
                 * container in `Actor.ID` and the legacy top-level `id` is
                 * gone. Reading only the old field meant every event was
                 * silently skipped — the service logged "izleniyor" and
                 * rescued nothing, which is the failure mode this whole file
                 * exists to end. Both are read so one daemon version cannot
                 * quietly disable it again.
                 */
                const id = event.Actor?.ID ?? event.id;
                if (typeof id !== "string" || id === "") continue;
                const name = event.Actor?.Attributes?.["name"] ?? id.slice(0, 12);
                void restart(socketPath, id, name, log);
              } catch {
                // A line Docker sent that this cannot parse is not a reason to
                // stop watching the ones it can.
              }
            }
          });
          response.on("end", () => resolve());
        },
      );
      call.on("error", (error: Error) => {
        log(`[maestro] autoheal: olay akışı koptu (${error.message}) — yeniden bağlanılacak`);
        resolve();
      });
      void options.until?.then(() => call.destroy());
      call.end();
    });
    if (stopped) break;
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS));
  }
}

export async function main(): Promise<void> {
  const project = process.env["COMPOSE_PROJECT_NAME"]?.trim();
  if (project === undefined || project === "") {
    throw new Error(
      "COMPOSE_PROJECT_NAME: required — autoheal restarts only THIS stack's containers, and " +
        "without the project name the filter would match every container on the host.",
    );
  }
  console.info(`[maestro] autoheal: "${project}" yığınının sağlıksız konteynerleri izleniyor`);
  // Sweep BEFORE watching: anything already unhealthy emitted its event before
  // this process existed and would otherwise never be seen.
  await sweepUnhealthy({ project });
  await watchUnhealthy({ project });
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
