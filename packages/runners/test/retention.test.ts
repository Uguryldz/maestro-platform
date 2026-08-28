import { describe, expect, it } from "vitest";
import { RunnerLeaseError } from "../src/errors.js";
import { FIXTURES, httpResponse, runnerRig as rig, TEST_CONFIG, TEST_JOB } from "./helpers.js";

/**
 * Cache mounting (M31 layer ①) and workspace retention (M31 layer ② / M65) —
 * the parts of the driver that outlive a single session, split out of
 * `docker-runner.test.ts` so both files stay readable.
 */

describe("mountCache (M31 layer ①)", () => {
  it("creates the volume and mounts it into the next session", async () => {
    const { runner, matching } = rig({ "GET /volumes/": () => FIXTURES.volumeNotFound() });
    const lease = await runner.acquire("linux-node");

    await runner.mountCache(lease, ["dep-linux-node-npm-abc123abc123"]);
    await runner.runSession(lease, TEST_JOB);

    const created = JSON.parse(matching("/volumes/create")[0]?.body ?? "{}");
    expect(created.Name).toMatch(/^maestro-cache-dep-linux-node-npm-abc123abc123-[0-9a-f]{12}$/);
    expect(created.Labels).toMatchObject({ "maestro.cache-key": "dep-linux-node-npm-abc123abc123" });

    // The LAST container created is the job; the one before it prepared the
    // freshly created workspace volume (provision.test.ts covers that path).
    const spec = JSON.parse(matching("/containers/create").at(-1)?.body ?? "{}");
    expect(spec.HostConfig.Binds).toHaveLength(2);
    // The name the volume was CREATED under must be the name that gets bound:
    // a mismatch here is a silently empty cache on every run.
    expect(spec.HostConfig.Binds[1]).toBe(`${created.Name}:/cache/dep-linux-node-npm-abc123abc123:ro`);
  });

  it("provisions the workspace volume on the configured (encrypted) driver, and binds that name", async () => {
    const { runner, matching } = rig({ "GET /volumes/": () => FIXTURES.volumeNotFound() }, {
      ...TEST_CONFIG,
      workspace: { volumeDriver: "local", volumeOptions: { device: "/dev/mapper/maestro-crypt", type: "ext4" } },
    });
    const lease = await runner.acquire("linux-node");

    await runner.runSession(lease, TEST_JOB);
    const created = JSON.parse(matching("/volumes/create")[0]?.body ?? "{}");
    const spec = JSON.parse(matching("/containers/create")[0]?.body ?? "{}");

    expect(created).toMatchObject({
      Driver: "local",
      DriverOpts: { device: "/dev/mapper/maestro-crypt", type: "ext4" },
      Labels: { "maestro.layer": "workspace", "maestro.workspace-key": TEST_JOB.workspaceKey },
    });
    expect(spec.HostConfig.Binds[0]).toBe(`${created.Name}:/workspace:rw`);
  });

  it("removes the volume it created when the workspace is swept", async () => {
    // Missing on the way in (so it gets created), present on the way out.
    let exists = false;
    const { runner, matching } = rig({
      "GET /volumes/": () => (exists ? FIXTURES.volumeInspect() : FIXTURES.volumeNotFound()),
      "POST /volumes/create": () => {
        exists = true;
        return FIXTURES.volumeCreate();
      },
    });
    const lease = await runner.acquire("linux-node");

    await runner.runSession(lease, TEST_JOB);
    const created = JSON.parse(matching("/volumes/create")[0]?.body ?? "{}");
    await runner.removeWorkspace(TEST_JOB.workspaceKey, "ticket-closed");

    const deleted = matching("/volumes/").filter((request) => request.method === "DELETE");
    expect(deleted[0]?.path).toBe(`/v1.44/volumes/${created.Name}?force=true`);
  });

  it("refuses an invalid cache key before any volume is created", async () => {
    const { runner, requests } = rig();
    const lease = await runner.acquire("linux-node");

    await expect(runner.mountCache(lease, ["../escape"])).rejects.toThrow(/invalid runner key/);
    expect(requests).toHaveLength(0);
  });

  it("bounds how many caches one job can mount", async () => {
    const { runner } = rig();
    const lease = await runner.acquire("linux-node");
    const keys = Array.from({ length: 9 }, (_, index) => `dep-${index}`);

    await expect(runner.mountCache(lease, keys)).rejects.toThrow(/at most 8/);
  });

  /**
   * The limit is about MOUNTS. Counting the same key twice refuses work the
   * driver could do — `attachCache` already de-duplicates, so the eight mounts
   * were never nine.
   */
  it("counts the limit over distinct keys, not over calls", async () => {
    const { runner } = rig();
    const lease = await runner.acquire("linux-node");
    const keys = Array.from({ length: 8 }, (_, index) => `dep-${index}`);

    await runner.mountCache(lease, keys);
    await expect(runner.mountCache(lease, keys)).resolves.toBeUndefined();
    await expect(runner.mountCache(lease, ["dep-9"])).rejects.toThrow(/at most 8/);
  });

  it("refuses to mount onto a lease that was never issued", async () => {
    const { runner } = rig();

    await expect(
      runner.mountCache({ leaseId: "ghost", runnerId: "docker-linux/linux-node/0", platform: "linux-node" }, ["dep-a"]),
    ).rejects.toThrow(RunnerLeaseError);
  });
});

describe("release and workspace lifecycle", () => {
  it("is idempotent and frees the slot", async () => {
    const { runner } = rig({}, { ...TEST_CONFIG, platforms: { "linux-node": { image: TEST_CONFIG.platforms["linux-node"].image, capacity: 1 } } });
    const lease = await runner.acquire("linux-node");

    await runner.release(lease);
    await expect(runner.release(lease)).resolves.toBeUndefined();
    await expect(runner.acquire("linux-node")).resolves.toMatchObject({ runnerId: lease.runnerId });
  });

  it("removes a workspace volume with an audit record (M31/M65)", async () => {
    const { runner, matching, audit } = rig();

    await expect(runner.removeWorkspace("UGURPAY-1042", "ticket-closed")).resolves.toBe(true);

    expect(matching("/volumes/").filter((request) => request.method === "DELETE")[0]?.path).toContain("force=true");
    expect(audit[0]).toMatchObject({ action: "RETENTION_ARCHIVE", meta: { workspaceKey: "UGURPAY-1042", reason: "ticket-closed" } });
  });

  /**
   * O3: the daemon answering 404 means there was nothing to delete. Writing
   * RETENTION_ARCHIVE anyway puts a deletion that never happened into the M33
   * chain — and a retried sweep writes it a second time.
   */
  it("does not archive a workspace that was not there", async () => {
    const { runner, audit } = rig({ "DELETE /volumes/": () => FIXTURES.notFound() });

    await expect(runner.removeWorkspace("UGURPAY-1042", "ticket-closed")).resolves.toBe(false);

    expect(audit).toHaveLength(0);
  });

  /**
   * `DELETE /volumes/{name}?force=true` answers 204 for a volume that never
   * existed — that is what `force` MEANS to the daemon (Engine 29.4). Reading
   * "204" as "we deleted it" is how a retention log fills with archives of
   * workspaces nobody ever created, so the volume is looked up first.
   */
  it("does not read the daemon's forced 204 as a deletion", async () => {
    const { runner, audit, matching } = rig({ "GET /volumes/": () => FIXTURES.volumeNotFound() });

    await expect(runner.removeWorkspace("UGURPAY-1042", "ticket-closed")).resolves.toBe(false);

    expect(audit).toHaveLength(0);
    expect(matching("/volumes/").filter((request) => request.method === "DELETE")).toHaveLength(0);
  });

  it("sweeps only the workspaces past the configured age", async () => {
    const { runner, audit } = rig({}, { ...TEST_CONFIG, workspace: { maxAgeDays: 30 } });

    const report = await runner.sweepExpiredWorkspaces([
      { workspaceKey: "UGURPAY-1", lastUsedAt: "2026-01-01T00:00:00.000Z" },
      { workspaceKey: "UGURPAY-2", lastUsedAt: "2026-08-01T00:00:00.000Z" },
    ]);

    expect(report).toEqual({ swept: ["UGURPAY-1"], missing: [], failed: [] });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.meta["reason"]).toBe("workspace-max-age");
  });

  /**
   * O2: the sweep used to abandon the loop on the first failure, so one busy
   * volume hid every workspace behind it — and the caller got an exception
   * instead of the list of what actually went.
   */
  it("keeps sweeping after a failure and reports which workspace refused", async () => {
    const failing = "maestro-ws-ugurpay-2-";
    const { runner } = rig(
      {
        "DELETE /volumes/": (request) =>
          request.path.includes(failing) ? httpResponse(409, "{\"message\":\"volume is in use\"}") : FIXTURES.volumeRemove(),
      },
      { ...TEST_CONFIG, workspace: { maxAgeDays: 30 } },
    );

    const report = await runner.sweepExpiredWorkspaces([
      { workspaceKey: "UGURPAY-1", lastUsedAt: "2026-01-01T00:00:00.000Z" },
      { workspaceKey: "UGURPAY-2", lastUsedAt: "2026-01-01T00:00:00.000Z" },
      { workspaceKey: "UGURPAY-3", lastUsedAt: "2026-01-01T00:00:00.000Z" },
    ]);

    expect(report.swept).toEqual(["UGURPAY-1", "UGURPAY-3"]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]?.workspaceKey).toBe("UGURPAY-2");
    expect(report.failed[0]?.reason).toContain("409");
  });

  it("separates 'already gone' from 'swept' so the archive count is honest", async () => {
    const { runner, audit } = rig({ "DELETE /volumes/": () => FIXTURES.notFound() }, {
      ...TEST_CONFIG,
      workspace: { maxAgeDays: 30 },
    });

    const report = await runner.sweepExpiredWorkspaces([
      { workspaceKey: "UGURPAY-1", lastUsedAt: "2026-01-01T00:00:00.000Z" },
    ]);

    expect(report).toEqual({ swept: [], missing: ["UGURPAY-1"], failed: [] });
    expect(audit).toHaveLength(0);
  });

  it("pings the daemon through the same transport", async () => {
    const { runner } = rig();

    await expect(runner.ping()).resolves.toBe(true);
  });
});
