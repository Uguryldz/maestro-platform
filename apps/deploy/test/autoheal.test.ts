import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sweepUnhealthy, watchUnhealthy } from "../src/bin/autoheal.js";

/**
 * The autohealer, against a stand-in Docker daemon.
 *
 * Compose does not restart a container because it went unhealthy — it reacts to
 * the process EXITING — so a worker that is alive but no longer polling gets
 * marked `unhealthy` and then left there forever. This service closes that
 * loop, which means it holds the daemon socket, which means its SCOPE is the
 * thing worth testing: it must restart this stack's containers and nothing
 * else, and it must know no verb but restart.
 */

interface FakeDocker {
  readonly socketPath: string;
  /** Every request path the autohealer asked for, in order. */
  readonly calls: string[];
  /** Push a `health_status: unhealthy` line onto the open event stream. */
  emit(event: unknown): void;
  close(): Promise<void>;
}

function fakeDocker(
  options: { restartStatus?: number; unhealthy?: Array<{ Id: string; Names: string[] }> } = {},
): Promise<FakeDocker> {
  const dir = mkdtempSync(join(tmpdir(), "maestro-autoheal-"));
  const socketPath = join(dir, "docker.sock");
  const calls: string[] = [];
  let stream: { write(chunk: string): void } | null = null;

  const server: Server = createServer((request, response) => {
    calls.push(`${request.method} ${request.url ?? ""}`);
    if ((request.url ?? "").startsWith("/events")) {
      response.writeHead(200, { "content-type": "application/json" });
      stream = response;
      return;
    }
    if ((request.url ?? "").startsWith("/containers/json")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(options.unhealthy ?? []));
      return;
    }
    response.writeHead(options.restartStatus ?? 204).end();
  });

  return new Promise((resolve) => {
    server.listen(socketPath, () =>
      resolve({
        socketPath,
        calls,
        emit: (event) => stream?.write(`${JSON.stringify(event)}\n`),
        close: () =>
          new Promise((done) => {
            server.close(() => {
              rmSync(dir, { recursive: true, force: true });
              done();
            });
          }),
      }),
    );
  });
}

/** Give the autohealer a moment to act on what the daemon just sent. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60));

let docker: FakeDocker | null = null;
let stop: (() => void) | null = null;

afterEach(async () => {
  stop?.();
  await docker?.close();
  docker = null;
  stop = null;
});

/** Start the watcher against the fake, returning once it has subscribed. */
async function watching(project = "maestroprod"): Promise<FakeDocker> {
  const fake = await fakeDocker();
  docker = fake;
  const until = new Promise<void>((resolve) => (stop = resolve));
  void watchUnhealthy({ project, socketPath: fake.socketPath, until, log: () => undefined });
  await settle();
  return fake;
}

describe("autoheal", () => {
  it("restarts a container Docker reported unhealthy", async () => {
    const fake = await watching();

    fake.emit({ id: "abc123", Actor: { Attributes: { name: "maestroprod-worker-1" } } });
    await settle();

    expect(fake.calls).toContain("POST /containers/abc123/restart?t=30");
  });

  /**
   * The scope guarantee, and the reason this file exists. The filter is applied
   * by DOCKER, from the compose project label — so a process holding the daemon
   * socket cannot be talked into bouncing something else on the host by a
   * crafted event.
   */
  it("subscribes ONLY to this project's unhealthy events", async () => {
    const fake = await watching("maestroprod");

    const subscribe = fake.calls.find((call) => call.startsWith("GET /events"));
    expect(subscribe).toBeDefined();
    const filters = JSON.parse(
      decodeURIComponent(new URL(`http://x${subscribe!.slice(4)}`).searchParams.get("filters") ?? ""),
    ) as Record<string, string[]>;

    expect(filters["label"]).toEqual(["com.docker.compose.project=maestroprod"]);
    expect(filters["event"]).toEqual(["health_status: unhealthy"]);
    expect(filters["type"]).toEqual(["container"]);
  });

  it("knows no verb but restart — it never creates, removes or reconfigures", async () => {
    const fake = await watching();

    fake.emit({ id: "abc123", Actor: { Attributes: { name: "maestroprod-worker-1" } } });
    await settle();

    for (const call of fake.calls) {
      expect(call).toMatch(/^GET \/events|^POST \/containers\/[a-z0-9]+\/restart/);
    }
  });

  it("ignores a line it cannot parse rather than giving up on the stream", async () => {
    const fake = await watching();

    fake.emit("not-an-object-with-an-id");
    fake.emit({ Actor: { Attributes: { name: "no-id-here" } } });
    fake.emit({ id: "abc123", Actor: { Attributes: { name: "maestroprod-worker-1" } } });
    await settle();

    // The good event still landed, and nothing was restarted for the bad ones.
    const restarts = fake.calls.filter((call) => call.includes("/restart"));
    expect(restarts).toEqual(["POST /containers/abc123/restart?t=30"]);
  });

  /**
   * A daemon that refuses one restart is not a reason to stop watching: the
   * next unhealthy event will try again, and an autohealer that dies on a
   * transient error is an autohealer that is absent when it is needed.
   */
  it("survives a refused restart and keeps watching", async () => {
    const fake = await fakeDocker({ restartStatus: 500 });
    docker = fake;
    const until = new Promise<void>((resolve) => (stop = resolve));
    const logged: string[] = [];
    void watchUnhealthy({
      project: "maestroprod",
      socketPath: fake.socketPath,
      until,
      log: (message) => logged.push(message),
    });
    await settle();

    fake.emit({ id: "abc123", Actor: { Attributes: { name: "maestroprod-worker-1" } } });
    await settle();
    fake.emit({ id: "def456", Actor: { Attributes: { name: "maestroprod-bff-1" } } });
    await settle();

    expect(fake.calls.filter((call) => call.includes("/restart"))).toHaveLength(2);
    expect(logged.join(" ")).toContain("yeniden başlatılamadı");
  });

  /**
   * Docker emits `health_status: unhealthy` on the TRANSITION only.
   *
   * Measured live: a worker that had been unhealthy for eight minutes produced
   * no further events, so a watcher that had just started was blind to it —
   * which is every deploy, and every time the autohealer itself restarts. The
   * sweep is what makes "hiç ölmeyecek" true rather than "will not die from
   * now on, provided it was healthy when we looked".
   */
  it("rescues a container that was ALREADY unhealthy before it started watching", async () => {
    const fake = await fakeDocker({
      unhealthy: [{ Id: "wedged1", Names: ["/maestroprod-worker-1"] }],
    });
    docker = fake;

    const healed = await sweepUnhealthy({
      project: "maestroprod",
      socketPath: fake.socketPath,
      log: () => undefined,
    });

    expect(healed).toBe(1);
    expect(fake.calls).toContain("POST /containers/wedged1/restart?t=30");
  });

  it("sweeps with the same project scope as the watch", async () => {
    const fake = await fakeDocker({ unhealthy: [] });
    docker = fake;

    await sweepUnhealthy({ project: "maestroprod", socketPath: fake.socketPath, log: () => undefined });

    const listed = fake.calls.find((call) => call.startsWith("GET /containers/json"));
    expect(listed).toBeDefined();
    const filters = JSON.parse(
      decodeURIComponent(
        new URL(`http://x${listed!.slice(4)}`).searchParams.get("filters") ?? "",
      ),
    ) as Record<string, string[]>;
    expect(filters["label"]).toEqual(["com.docker.compose.project=maestroprod"]);
    expect(filters["health"]).toEqual(["unhealthy"]);
  });

  /**
   * Found live, twice, on a real install — both times the autohealer LOOKED
   * fine and did nothing useful.
   *
   * The restart request must outlast the stop grace it asks for. They were
   * both 30s: Docker answers only once the container is back up, so the
   * request timed out one instant before the reply and the log claimed a
   * failure for a restart that had SUCCEEDED. An operator reading that goes
   * hunting for a broken autohealer that works.
   */
  it("waits longer for a restart than the stop grace it asks for", async () => {
    const source = readFileSync(new URL("../src/bin/autoheal.ts", import.meta.url), "utf8");
    const grace = /const STOP_GRACE_S = (\d+);/u.exec(source);
    const timeout = /const RESTART_TIMEOUT_MS = \(STOP_GRACE_S \+ (\d+)\)/u.exec(source);

    expect(grace).not.toBeNull();
    expect(timeout).not.toBeNull();
    expect(Number(timeout![1])).toBeGreaterThan(0);
    // And the request actually asks for that grace, rather than a stale literal.
    expect(source).toContain("`/containers/${id}/restart?t=${STOP_GRACE_S}`");
  });

  /**
   * Docker 29 moved the container id out of the top-level `id` and into
   * `Actor.ID`. Measured against a real daemon: reading only the legacy field
   * made every event a no-op — the service logged "izleniyor" and rescued
   * nothing, which is precisely the silent uselessness it exists to end.
   */
  it("reads the container id from Actor.ID, as modern Docker sends it", async () => {
    const fake = await watching();

    fake.emit({
      Type: "container",
      Action: "health_status: unhealthy",
      Actor: { ID: "modern1", Attributes: { name: "maestroprod-worker-1" } },
    });
    await settle();

    expect(fake.calls).toContain("POST /containers/modern1/restart?t=30");
  });

  it("still understands the legacy top-level id", async () => {
    const fake = await watching();

    fake.emit({ id: "legacy1", Actor: { Attributes: { name: "maestroprod-worker-1" } } });
    await settle();

    expect(fake.calls).toContain("POST /containers/legacy1/restart?t=30");
  });
});
