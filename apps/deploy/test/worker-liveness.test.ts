import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { healthPortOf, startWorkerLiveness } from "../src/worker-liveness.js";

/**
 * The worker's liveness probe.
 *
 * The worker serves no HTTP of its own, so its compose healthcheck was `NONE`
 * and `restart: unless-stopped` was the whole safety net — a policy that reacts
 * to the process DYING. The failure that actually strands an installation is
 * the opposite: the worker alive but no longer polling, so the queue fills,
 * nothing is logged after the last good run, and the analysis "never finishes".
 */

/** Ask the probe, returning what an operator (and Docker) would see. */
async function probe(port: number, path = "/healthz"): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: response.status, body: await response.text() };
}

/** A port nothing else on the machine is using, derived from the test's own pid. */
function freePort(offset: number): number {
  return 45_000 + ((process.pid + offset) % 10_000);
}

describe("healthPortOf", () => {
  it("is off unless the deployment asks for it", () => {
    expect(healthPortOf({})).toBeNull();
    expect(healthPortOf({ WORKER_HEALTH_PORT: "" })).toBeNull();
    expect(healthPortOf({ WORKER_HEALTH_PORT: "   " })).toBeNull();
  });

  it("reads a port", () => {
    expect(healthPortOf({ WORKER_HEALTH_PORT: "7002" })).toBe(7002);
    expect(healthPortOf({ WORKER_HEALTH_PORT: " 7002 " })).toBe(7002);
  });

  /**
   * A typo in a MONITORING variable must never be the reason a bank has no
   * delivery. The worker's job is analyses; the probe is a convenience.
   */
  it("treats a nonsense value as 'not asked' rather than refusing to start", () => {
    expect(healthPortOf({ WORKER_HEALTH_PORT: "yedi bin" })).toBeNull();
    expect(healthPortOf({ WORKER_HEALTH_PORT: "0" })).toBeNull();
    expect(healthPortOf({ WORKER_HEALTH_PORT: "70000" })).toBeNull();
    expect(healthPortOf({ WORKER_HEALTH_PORT: "-1" })).toBeNull();
  });
});

describe("startWorkerLiveness", () => {
  it("answers 503 until the worker is actually polling, then 200", async () => {
    const port = freePort(1);
    const liveness = startWorkerLiveness({ port });
    try {
      // Before the Temporal worker reaches RUNNING: alive, but not able to work.
      // 503 is the honest answer, and it is what makes the healthcheck restart
      // a wedged worker instead of leaving it to fill the queue.
      const starting = await probe(port);
      expect(starting.status).toBe(503);
      expect(JSON.parse(starting.body)).toEqual({ status: "starting", polling: false });

      liveness.setReady(true);
      const ready = await probe(port);
      expect(ready.status).toBe(200);
      expect(JSON.parse(ready.body)).toEqual({ status: "ok", polling: true });
    } finally {
      await liveness.close();
    }
  });

  it("goes unready again when the worker stops, so a drain is not read as healthy", async () => {
    const port = freePort(2);
    const liveness = startWorkerLiveness({ port });
    try {
      liveness.setReady(true);
      expect((await probe(port)).status).toBe(200);
      liveness.setReady(false);
      expect((await probe(port)).status).toBe(503);
    } finally {
      await liveness.close();
    }
  });

  it("serves the probe and nothing else", async () => {
    const port = freePort(3);
    const liveness = startWorkerLiveness({ port });
    try {
      liveness.setReady(true);
      expect((await probe(port, "/")).status).toBe(404);
      expect((await probe(port, "/studio/runs")).status).toBe(404);
    } finally {
      await liveness.close();
    }
  });

  /**
   * A worker that cannot open its health port is still a worker that runs
   * analyses. Refusing to start here would turn a monitoring gap into an
   * outage — the exact trade this probe exists to avoid.
   */
  it("survives a port that is already taken, and says so", async () => {
    const port = freePort(4);
    const holder = startWorkerLiveness({ port });
    const logged: string[] = [];
    try {
      const second = startWorkerLiveness({ port, log: (message) => logged.push(message) });
      // Constructed and usable; the bind failure arrives asynchronously.
      second.setReady(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(logged.join(" ")).toContain("sağlık ucu açılamadı");
      await second.close();
    } finally {
      await holder.close();
    }
  });
});

/**
 * The probe is only worth having if READY means "polling the queue".
 *
 * The first version of this wiring called `setReady(true)` on the line BEFORE
 * `startMaestroWorker`, which proved only that the process had reached that
 * line — precisely the thing that stays true while a worker is wedged. The
 * probe would then have agreed with the failure it exists to catch.
 *
 * Asserted against the source because the alternative is a live Temporal
 * server in a unit test; what matters here is the wiring decision, and that is
 * visible in the text.
 */
describe("the worker reports ready from the ENGINE's state, not from reaching a line", () => {
  const source = readFileSync(new URL("../src/bin/worker.ts", import.meta.url), "utf8");

  it("derives readiness from the worker state being RUNNING", () => {
    expect(source).toContain('onState: (state) => liveness?.setReady(state === "RUNNING")');
  });

  it("never reports ready unconditionally", () => {
    expect(source).not.toContain("setReady(true)");
  });
});
