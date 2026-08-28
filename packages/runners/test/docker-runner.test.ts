import { CapabilityNotSupportedError } from "@maestro/ports";
import { describe, expect, it } from "vitest";
import { TIMEOUT_EXIT_CODE } from "../src/docker-runner.js";
import { DockerHttpError, RunnerCapacityError, RunnerConfigError, RunnerLeaseError } from "../src/errors.js";
import {
  FIXTURE_CONTAINER_ID,
  FIXTURES,
  type Handler,
  httpResponse,
  runnerRig as rig,
  TEST_CONFIG,
  TEST_JOB,
  until,
} from "./helpers.js";

describe("acquire (M21)", () => {
  it("leases a configured linux platform", async () => {
    const { runner } = rig();

    const lease = await runner.acquire("linux-node");

    expect(lease).toEqual({ leaseId: "lease-00000001", runnerId: "docker-linux/linux-node/0", platform: "linux-node" });
  });

  it("refuses mac/win — those runners connect outbound through the agent driver (M22)", async () => {
    const { runner } = rig();

    await expect(runner.acquire("macos-xcode")).rejects.toThrow(CapabilityNotSupportedError);
    await expect(runner.acquire("windows-dotnet")).rejects.toThrow(CapabilityNotSupportedError);
  });

  it("refuses a linux platform this deployment does not serve", async () => {
    const { runner } = rig();

    await expect(runner.acquire("linux-android")).rejects.toThrow(RunnerCapacityError);
  });

  it("stops at the configured capacity instead of over-committing the host", async () => {
    const { runner } = rig({}, { ...TEST_CONFIG, platforms: { "linux-node": { image: TEST_CONFIG.platforms["linux-node"].image, capacity: 1 } } });

    await runner.acquire("linux-node");

    await expect(runner.acquire("linux-node")).rejects.toThrow(RunnerCapacityError);
  });

  it("touches the daemon for nothing — acquiring is local bookkeeping", async () => {
    const { runner, requests } = rig();

    await runner.acquire("linux-node");

    expect(requests).toHaveLength(0);
  });
});

describe("runSession happy path", () => {
  it("creates, starts, waits, tails and removes — in that order", async () => {
    const { runner, requests, clock } = rig();
    const lease = await runner.acquire("linux-node");

    const result = await runner.runSession(lease, TEST_JOB);

    expect(requests.map((request) => `${request.method} ${request.path.split("?")[0]}`)).toEqual([
      "GET /v1.44/networks/maestro-egress",
      "GET /v1.44/volumes/maestro-ws-ugurpay-1042-4e704206aec4",
      "POST /v1.44/containers/create",
      `POST /v1.44/containers/${FIXTURE_CONTAINER_ID}/start`,
      `POST /v1.44/containers/${FIXTURE_CONTAINER_ID}/wait`,
      `GET /v1.44/containers/${FIXTURE_CONTAINER_ID}/logs`,
      `DELETE /v1.44/containers/${FIXTURE_CONTAINER_ID}`,
    ]);
    expect(result.exitCode).toBe(7);
    expect(result.stdoutTail).toBe("hello-stdout\n");
    expect(result.stderrTail).toBe("hello-stderr\n");
    expect(result.durationMs).toBe(0);
    expect(clock.clock()).toBeInstanceOf(Date);
  });

  it("sends the hardened spec, not a bare image reference", async () => {
    const { runner, matching } = rig();
    const lease = await runner.acquire("linux-node");

    await runner.runSession(lease, TEST_JOB);
    const spec = JSON.parse(matching("/containers/create")[0]?.body ?? "{}");

    expect(spec.HostConfig).toMatchObject({ ReadonlyRootfs: true, CapDrop: ["ALL"], NetworkMode: "maestro-egress" });
    expect(spec.User).toBe("10001:10001");
    expect(spec.Image).toBe(TEST_CONFIG.platforms["linux-node"].image);
  });

  it("measures duration from the injected clock", async () => {
    const { runner, clock } = rig({
      "/wait": () => {
        clock.advance(4_200);
        return FIXTURES.wait();
      },
    });
    const lease = await runner.acquire("linux-node");

    expect((await runner.runSession(lease, TEST_JOB)).durationMs).toBe(4_200);
  });

  it("truncates huge output to the configured tail", async () => {
    const frame = (stream: number, payload: string): Buffer => {
      const header = Buffer.alloc(8);
      header[0] = stream;
      header.writeUInt32BE(Buffer.byteLength(payload), 4);
      return Buffer.concat([header, Buffer.from(payload, "utf8")]);
    };
    const noisy = frame(1, "x".repeat(50_000)).toString("latin1");
    const { runner } = rig({ "/logs": () => httpResponse(200, noisy, { headers: { "Content-Type": "application/octet-stream" } }) },
      { ...TEST_CONFIG, maxTailBytes: 1_024 });
    const lease = await runner.acquire("linux-node");

    const result = await runner.runSession(lease, TEST_JOB);

    expect(result.stdoutTail.length).toBe(1_024);
  });

  it("records SANDBOX_CREATE and SANDBOX_DESTROY for the audit chain (M33)", async () => {
    const { runner, audit } = rig();
    const lease = await runner.acquire("linux-node");

    await runner.runSession(lease, TEST_JOB);

    expect(audit.map((record) => record.action)).toEqual(["SANDBOX_CREATE", "SANDBOX_DESTROY"]);
    expect(audit.every((record) => record.meta["purpose"] === undefined)).toBe(true);
    expect(audit[0]).toMatchObject({ actor: "maestro-runner", at: "2026-08-08T14:20:00.000Z" });
    expect(audit[0]?.meta).toMatchObject({ runId: TEST_JOB.runId, networkMode: "maestro-egress" });
    expect(audit[1]?.meta).toMatchObject({ exitCode: 7, timedOut: false });
  });

  it("frees the lease for a second session but keeps the slot leased", async () => {
    const { runner } = rig();
    const lease = await runner.acquire("linux-node");

    await runner.runSession(lease, TEST_JOB);
    await expect(runner.runSession(lease, TEST_JOB)).resolves.toMatchObject({ exitCode: 7 });
    expect(runner.snapshot()[0]).toMatchObject({ leased: 1, running: 0 });
  });
});

describe("timeout (M23)", () => {
  const hangingWait: Handler = () => new Promise<never>(() => undefined);

  it("kills the container and still answers with the partial output", async () => {
    const { runner, timer, matching } = rig({ "/wait": hangingWait });
    const lease = await runner.acquire("linux-node");

    const pending = runner.runSession(lease, { ...TEST_JOB, timeoutSeconds: 30 });
    await until(() => timer.requested.length > 0, "the timeout to be armed");
    timer.fire();
    const result = await pending;

    expect(timer.requested).toEqual([30_000]);
    expect(matching("/kill")).toHaveLength(1);
    expect(matching("/kill")[0]?.path).toContain("signal=SIGKILL");
    expect(result.exitCode).toBe(TIMEOUT_EXIT_CODE);
    expect(result.stdoutTail).toBe("hello-stdout\n");
  });

  it("removes the container even when the job had to be killed", async () => {
    const { runner, timer, matching } = rig({ "/wait": hangingWait });
    const lease = await runner.acquire("linux-node");

    const pending = runner.runSession(lease, TEST_JOB);
    await until(() => timer.requested.length > 0, "the timeout to be armed");
    timer.fire();
    await pending;

    expect(matching("containers/" + FIXTURE_CONTAINER_ID).filter((r) => r.method === "DELETE")).toHaveLength(1);
  });

  it("says in the audit record that the budget, not the job, ended the run", async () => {
    const { runner, timer, audit } = rig({ "/wait": hangingWait });
    const lease = await runner.acquire("linux-node");

    const pending = runner.runSession(lease, { ...TEST_JOB, timeoutSeconds: 45 });
    await until(() => timer.requested.length > 0, "the timeout to be armed");
    timer.fire();
    await pending;

    expect(audit[1]?.meta).toMatchObject({
      timedOut: true,
      timeoutSeconds: 45,
      messageKey: "runner.session_timeout",
    });
  });

  it("an ABORTED session kills the container and REJECTS — never a usable result", async () => {
    const { runner, matching } = rig({ "/wait": hangingWait });
    const lease = await runner.acquire("linux-node");
    const control = new AbortController();

    const pending = runner.runSession(lease, TEST_JOB, control.signal);
    await until(() => matching("/start").length > 0, "the container to start");
    control.abort(new Error("kill_switch_stop_all"));

    // Rejecting is the contract. Returning a RunResult after an abort is what
    // let a caller label a finished build "cancelled" instead of stopping it.
    await expect(pending).rejects.toThrow(/kill_switch_stop_all/);
    expect(matching("/kill")).toHaveLength(1);
    // Ephemeral either way: an aborted session leaves nothing behind.
    expect(matching("containers/" + FIXTURE_CONTAINER_ID).filter((r) => r.method === "DELETE")).toHaveLength(1);
  });

  it("refuses an ALREADY-aborted signal before it creates anything", async () => {
    const { runner, matching } = rig();
    const lease = await runner.acquire("linux-node");

    await expect(runner.runSession(lease, TEST_JOB, AbortSignal.abort(new Error("too late")))).rejects.toThrow();
    // Nothing was created, so there is nothing to leak.
    expect(matching("/create")).toHaveLength(0);
  });

  it("a signal that never fires does not disturb the happy path", async () => {
    const { runner } = rig();
    const lease = await runner.acquire("linux-node");

    const result = await runner.runSession(lease, TEST_JOB, new AbortController().signal);

    // The fixture's exit code, passed straight through — an unfired signal
    // changes nothing about the session.
    expect(result.exitCode).toBe(7);
  });

  it("cancels the timer when the job finishes first — no dangling handle", async () => {
    const { runner, timer } = rig();
    const lease = await runner.acquire("linux-node");

    await runner.runSession(lease, TEST_JOB);

    expect(timer.cancelled).toBe(1);
  });

  it("refuses a timeout above the configured ceiling instead of silently clamping it", async () => {
    const { runner, requests } = rig({}, { ...TEST_CONFIG, maxTimeoutSeconds: 600 });
    const lease = await runner.acquire("linux-node");

    await expect(runner.runSession(lease, { ...TEST_JOB, timeoutSeconds: 601 })).rejects.toThrow(/ceiling/);
    expect(requests).toHaveLength(0);
  });

  it("refuses a missing or nonsensical timeout", async () => {
    const { runner } = rig();
    const lease = await runner.acquire("linux-node");

    await expect(runner.runSession(lease, { ...TEST_JOB, timeoutSeconds: 0 })).rejects.toThrow(RunnerConfigError);
    await expect(runner.runSession(lease, { ...TEST_JOB, timeoutSeconds: 1.5 })).rejects.toThrow(RunnerConfigError);
  });
});

describe("failure handling", () => {
  it("propagates a create failure and leaves no container behind", async () => {
    const { runner, requests } = rig({ "/containers/create": () => httpResponse(404, "{\"message\":\"no such image\"}") });
    const lease = await runner.acquire("linux-node");

    await expect(runner.runSession(lease, TEST_JOB)).rejects.toThrow(DockerHttpError);
    expect(requests.filter((request) => request.method === "DELETE")).toHaveLength(0);
  });

  it("removes the container when the start fails", async () => {
    const { runner, matching } = rig({ "/start": () => httpResponse(500, "{\"message\":\"boom\"}") });
    const lease = await runner.acquire("linux-node");

    await expect(runner.runSession(lease, TEST_JOB)).rejects.toThrow(/boom/);
    expect(matching("/containers/").filter((request) => request.method === "DELETE")).toHaveLength(1);
  });

  it("frees the running flag after a failure, so the lease stays usable", async () => {
    let fail = true;
    const { runner } = rig({
      "/start": () => (fail ? httpResponse(500, "{\"message\":\"boom\"}") : FIXTURES.start()),
    });
    const lease = await runner.acquire("linux-node");

    await expect(runner.runSession(lease, TEST_JOB)).rejects.toThrow();
    fail = false;

    await expect(runner.runSession(lease, TEST_JOB)).resolves.toMatchObject({ exitCode: 7 });
  });

  it("records a failed cleanup instead of hiding an orphan container", async () => {
    const { runner, audit } = rig({ "DELETE /containers/": () => httpResponse(500, "{\"message\":\"device busy\"}") });
    const lease = await runner.acquire("linux-node");

    await runner.runSession(lease, TEST_JOB);

    expect(audit.some((record) => record.meta["removeFailed"] === true)).toBe(true);
  });

  it("degrades to empty tails when the logs cannot be read, and says so", async () => {
    const { runner, audit } = rig({ "/logs": () => httpResponse(500, "{\"message\":\"log driver\"}") });
    const lease = await runner.acquire("linux-node");

    const result = await runner.runSession(lease, TEST_JOB);

    expect(result).toMatchObject({ exitCode: 7, stdoutTail: "", stderrTail: "" });
    expect(audit.some((record) => record.meta["logsUnavailable"] === true)).toBe(true);
  });

  it("refuses a session on a released lease", async () => {
    const { runner } = rig();
    const lease = await runner.acquire("linux-node");
    await runner.release(lease);

    await expect(runner.runSession(lease, TEST_JOB)).rejects.toThrow(RunnerLeaseError);
  });

  it("refuses two concurrent sessions on one lease", async () => {
    const { runner, timer } = rig({ "/wait": () => new Promise<never>(() => undefined) });
    const lease = await runner.acquire("linux-node");

    const first = runner.runSession(lease, TEST_JOB);
    await until(() => timer.requested.length > 0, "the first session to be running");
    await expect(runner.runSession(lease, TEST_JOB)).rejects.toThrow(/busy/);

    timer.fire();
    await first;
  });
});

