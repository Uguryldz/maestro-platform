import { afterAll, describe, expect, it } from "vitest";
import { RunnerConfigError } from "../src/errors.js";
import { createDockerLinuxRunner } from "../src/register.js";
import { IT_ENABLED, itImage, itRunner, leftovers, transport } from "./it-support.js";

/**
 * Escape battery (`MAESTRO_DOCKER_IT=1`): every attempt a hostile job would
 * make, tried inside a REAL container. The old smoke test asserted `id -u` and
 * nothing else, which is why a root container, an unwritable workspace and a
 * wide-open network all passed it.
 */

describe.skipIf(!IT_ENABLED)("a job cannot become root (M23)", () => {
  afterAll(async () => {
    if (!IT_ENABLED) return;
    expect((await leftovers()).containers).toEqual([]);
  });

  /**
   * K1: `sandbox.user` was checked with `startsWith("0:")` while Docker parses
   * the field numerically — `"00:0"` was accepted by the config and produced a
   * container running as root. The config must now refuse every spelling, and
   * the refusal is what keeps this test from being able to run one.
   */
  it("refuses every spelling of uid 0 before a container exists", async () => {
    const image = await itImage();
    for (const user of ["00:0", "000000:0", "0:0", "0:10001", "10001:0"]) {
      expect(() =>
        createDockerLinuxRunner(
          { platforms: { "linux-node": { image, capacity: 1 } }, sandbox: { user } },
          { transport },
        ),
      ).toThrow(RunnerConfigError);
    }
  });

  it("holds no capabilities at all and cannot gain any", { timeout: 180_000 }, async () => {
    const rig = await itRunner();
    try {
      const result = await rig.shell("grep -E 'CapEff|CapBnd|NoNewPrivs' /proc/self/status");

      expect(result.stdoutTail).toContain("CapEff:\t0000000000000000");
      expect(result.stdoutTail).toContain("CapBnd:\t0000000000000000");
      expect(result.stdoutTail).toContain("NoNewPrivs:\t1");
    } finally {
      await rig.release();
    }
  });

  /**
   * A job MAY set the setuid bit on a file it owns — that is ordinary POSIX and
   * the workspace is not a `nosuid` mount. It buys nothing: the file is owned
   * by the sandbox uid, so running it stays the sandbox uid, and the job cannot
   * chown it to root. What the test pins is the outcome, not the bit.
   */
  it("cannot reach uid 0 through su or through a setuid file", { timeout: 180_000 }, async () => {
    const rig = await itRunner();
    try {
      const result = await rig.shell(
        // Named `id` so the busybox copy runs that applet from argv[0].
        "su root -c id; echo su=$?; cp /bin/busybox /workspace/id; chmod u+s /workspace/id; " +
          "/workspace/id -u; chown 0:0 /workspace/id 2>&1; echo chown=$?",
      );

      expect(result.stdoutTail).not.toMatch(/uid=0\(root\)/);
      expect(result.stdoutTail).toMatch(/su=[1-9]/);
      // Executing the setuid copy: still the sandbox uid, never 0.
      expect(result.stdoutTail).toContain("10001");
      expect(result.stdoutTail).toMatch(/chown=[1-9]/);
      expect(`${result.stdoutTail}${result.stderrTail}`).toMatch(/not permitted|Operation not permitted/);
    } finally {
      await rig.release();
    }
  });

  it("has no docker socket to escalate through (M24)", { timeout: 180_000 }, async () => {
    const rig = await itRunner();
    try {
      const result = await rig.shell(
        "ls /var/run/docker.sock 2>&1; find / -name 'docker.sock' -maxdepth 4 2>/dev/null | head -1; echo done",
      );

      expect(result.stdoutTail).toContain("done");
      expect(result.stdoutTail).not.toMatch(/^\/.*docker\.sock$/m);
    } finally {
      await rig.release();
    }
  });
});

describe.skipIf(!IT_ENABLED)("the filesystem does not give a job a foothold (M23)", () => {
  it("has a read-only rootfs", { timeout: 180_000 }, async () => {
    const rig = await itRunner();
    try {
      const result = await rig.shell("touch /probe 2>&1; touch /usr/bin/probe 2>&1; echo done");

      expect(result.stdoutTail).toContain("Read-only file system");
      expect(result.stdoutTail).toContain("done");
    } finally {
      await rig.release();
    }
  });

  it("cannot execute anything it writes into /tmp", { timeout: 180_000 }, async () => {
    const rig = await itRunner();
    try {
      const result = await rig.shell("printf '#!/bin/sh\\necho ran\\n' > /tmp/x; chmod +x /tmp/x; /tmp/x 2>&1; echo done");

      expect(result.stdoutTail).not.toContain("ran");
      expect(result.stdoutTail).toContain("Permission denied");
    } finally {
      await rig.release();
    }
  });

  it("cannot mount anything (no CAP_SYS_ADMIN)", { timeout: 180_000 }, async () => {
    const rig = await itRunner();
    try {
      const result = await rig.shell("mount -t proc proc /workspace 2>&1; echo done");

      expect(result.stdoutTail).not.toMatch(/^ *$/);
      expect(result.stdoutTail).toContain("done");
      expect(result.stdoutTail).toMatch(/Operation not permitted|must be superuser|denied|not permitted/i);
    } finally {
      await rig.release();
    }
  });
});

describe.skipIf(!IT_ENABLED)("resource limits are real, not advisory (M23)", () => {
  it("kills a job that eats past its memory limit instead of the host", { timeout: 240_000 }, async () => {
    const rig = await itRunner({ sandbox: { memoryMb: 128, cpus: 1, pidsLimit: 64 } });
    try {
      // `tail /dev/zero` grows without bound; with MemorySwap == Memory there
      // is nowhere to swap it, so the cgroup OOM killer ends it (137).
      const result = await rig.shell("tail /dev/zero", 120);

      expect(result.exitCode).toBe(137);
    } finally {
      await rig.release();
    }
  });

  it("stops a fork bomb at the pids limit and still answers", { timeout: 240_000 }, async () => {
    const rig = await itRunner({ sandbox: { memoryMb: 256, cpus: 1, pidsLimit: 32 } });
    try {
      const result = await rig.shell("i=0; while [ $i -lt 400 ]; do sleep 20 & i=$((i+1)); done; echo spawned-all", 60);

      expect(`${result.stdoutTail}${result.stderrTail}`).toMatch(/can't fork|Resource temporarily unavailable/);
    } finally {
      await rig.release();
    }
  });

  it("refuses an image that is not digest-pinned (M27)", async () => {
    expect(() =>
      createDockerLinuxRunner({ platforms: { "linux-node": { image: "postgres:16-alpine" } } }, { transport }),
    ).toThrow(/digest-pinned/);
  });
});
