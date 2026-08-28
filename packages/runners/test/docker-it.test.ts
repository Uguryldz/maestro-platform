import { afterAll, describe, expect, it } from "vitest";
import { TIMEOUT_EXIT_CODE } from "../src/docker-runner.js";
import { IT_ENABLED, IT_PREFIX, itRunner, leftovers } from "./it-support.js";

/**
 * Lifecycle half of the opt-in battery (`MAESTRO_DOCKER_IT=1`): what a real
 * session does, end to end, against a real daemon — including the two things
 * the old smoke test never checked and therefore never caught, that the
 * workspace is WRITABLE and that a killed session leaves nothing behind.
 */

describe.skipIf(!IT_ENABLED)("docker-linux lifecycle against a real daemon", () => {
  afterAll(async () => {
    if (!IT_ENABLED) return;
    const left = await leftovers();
    expect(left.containers).toEqual([]);
    expect(left.volumes).toEqual([]);
  });

  it("runs a job and brings back the exit code and both streams", { timeout: 180_000 }, async () => {
    const rig = await itRunner();
    try {
      const result = await rig.shell("echo out; echo err 1>&2; exit 3");

      expect(result.exitCode).toBe(3);
      expect(result.stdoutTail).toContain("out");
      expect(result.stderrTail).toContain("err");
      expect(result.durationMs).toBeGreaterThan(0);
    } finally {
      await rig.release();
    }
  });

  it("runs as the configured non-root uid AND gid, inside the container", { timeout: 180_000 }, async () => {
    const rig = await itRunner();
    try {
      const result = await rig.shell("id -u; id -g; whoami 2>/dev/null || echo no-passwd-entry");

      expect(result.stdoutTail.split("\n")[0]).toBe("10001");
      expect(result.stdoutTail.split("\n")[1]).toBe("10001");
      expect(result.stdoutTail).not.toContain("root");
    } finally {
      await rig.release();
    }
  });

  /**
   * K4: this is the whole point of the package. An empty `local` volume is born
   * root:root 0755 and the job runs as 10001, so before the preparation step
   * `/workspace` was READ-ONLY: no clone, no build, and no M30 session files.
   */
  it("gives the job a writable workspace that survives into the next session", { timeout: 180_000 }, async () => {
    const rig = await itRunner();
    try {
      const wrote = await rig.shell(
        "set -e; touch /workspace/probe.txt; mkdir -p /workspace/.session; " +
          "echo resume-context > /workspace/.session/state.json; ls -ld /workspace",
      );
      expect(wrote.stderrTail).not.toContain("Permission denied");
      expect(wrote.exitCode).toBe(0);
      expect(wrote.stdoutTail).toContain("10001");

      const resumed = await rig.shell("cat /workspace/.session/state.json");
      expect(resumed.exitCode).toBe(0);
      expect(resumed.stdoutTail).toContain("resume-context");
    } finally {
      await rig.release();
    }
  });

  it("writes into HOME, which is the workspace", { timeout: 180_000 }, async () => {
    const rig = await itRunner();
    try {
      const result = await rig.shell('set -e; echo "$HOME"; touch "$HOME/home-probe"');

      expect(result.exitCode).toBe(0);
      expect(result.stdoutTail).toContain("/workspace");
    } finally {
      await rig.release();
    }
  });

  it("kills a job that outlives its budget and leaves no container behind", { timeout: 180_000 }, async () => {
    const rig = await itRunner();
    try {
      const started = Date.now();
      const killed = await rig.shell("sleep 300", 2);

      expect(killed.exitCode).toBe(TIMEOUT_EXIT_CODE);
      // A real SIGKILL, not a wait that quietly returned: 300 seconds of sleep
      // cannot have finished in the time this took.
      expect(Date.now() - started).toBeLessThan(60_000);
      expect((await leftovers()).containers).toEqual([]);
    } finally {
      await rig.release();
    }
  });

  it("keeps the partial output of a killed job", { timeout: 180_000 }, async () => {
    const rig = await itRunner();
    try {
      const killed = await rig.shell("echo before-the-kill; sleep 300", 3);

      expect(killed.exitCode).toBe(TIMEOUT_EXIT_CODE);
      expect(killed.stdoutTail).toContain("before-the-kill");
    } finally {
      await rig.release();
    }
  });

  it("removes the workspace volume it created when the ticket is closed", { timeout: 180_000 }, async () => {
    const rig = await itRunner({}, `${IT_PREFIX}/retention`);
    await rig.shell("echo hello > /workspace/file");

    await rig.runner.release(rig.lease);
    await expect(rig.runner.removeWorkspace(`${IT_PREFIX}/retention`, "ticket-closed")).resolves.toBe(true);
    // Removing it twice must not claim a second archive of the same volume.
    await expect(rig.runner.removeWorkspace(`${IT_PREFIX}/retention`, "ticket-closed")).resolves.toBe(false);
  });
});
