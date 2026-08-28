import { afterAll, describe, expect, it } from "vitest";
import { RunnerConfigError } from "../src/errors.js";
import { createDockerLinuxRunner } from "../src/register.js";
import { createNetwork, IT_ENABLED, IT_PREFIX, itImage, itRunner, leftovers, removeNetwork, transport } from "./it-support.js";

/**
 * Egress battery (`MAESTRO_DOCKER_IT=1`).
 *
 * K3 was proven on a live container: with an ordinary bridge network and an
 * unreachable proxy, `nc -w 3 -z 1.1.1.1 443` SUCCEEDED — the job simply
 * ignored `HTTP_PROXY`, and nothing was logged anywhere. Injecting proxy
 * variables is a request; the network is the control. These tests run the same
 * raw-TCP probe under each configuration the driver allows.
 */

const INTERNAL = `${IT_PREFIX}-internal`;
const OPEN = `${IT_PREFIX}-open`;
/** Deliberately nothing listening: a job must not be able to route around it. */
const DEAD_PROXY = "http://127.0.0.1:9";
const PROBE = "nc -w 3 -z 1.1.1.1 443; echo tcp=$?; getent hosts example.com >/dev/null 2>&1; echo dns=$?";

describe.skipIf(!IT_ENABLED)("egress is confined by the network (M26)", () => {
  afterAll(async () => {
    if (!IT_ENABLED) return;
    await removeNetwork(INTERNAL);
    await removeNetwork(OPEN);
    const left = await leftovers();
    expect(left.containers).toEqual([]);
    expect(left.networks).toEqual([]);
  });

  it("gives a job with no egress configuration no network at all", { timeout: 180_000 }, async () => {
    const rig = await itRunner();
    try {
      const result = await rig.shell(`${PROBE}; ip -o addr 2>/dev/null | wc -l`);

      expect(result.stdoutTail).toContain("tcp=1");
      expect(result.stdoutTail).not.toContain("tcp=0");
      expect(result.stdoutTail).toContain("dns=2");
    } finally {
      await rig.release();
    }
  });

  it("cannot open a raw socket to the internet on the internal egress network", { timeout: 180_000 }, async () => {
    await createNetwork(INTERNAL, true);
    const rig = await itRunner({ egress: { networkName: INTERNAL, proxyUrl: DEAD_PROXY } });
    try {
      const result = await rig.shell(PROBE);

      // The exact probe that succeeded before the fix.
      expect(result.stdoutTail).not.toContain("tcp=0");
      expect(result.stdoutTail).toContain("tcp=1");
    } finally {
      await rig.release();
    }
  });

  it("still hands the job the proxy variables, so a well-behaved job uses them", { timeout: 180_000 }, async () => {
    await createNetwork(INTERNAL, true).catch(() => undefined);
    const rig = await itRunner({ egress: { networkName: INTERNAL, proxyUrl: DEAD_PROXY } });
    try {
      const result = await rig.shell("echo $HTTP_PROXY; echo $https_proxy; echo $NO_PROXY");

      expect(result.stdoutTail).toContain(DEAD_PROXY);
      expect(result.stdoutTail).toContain("127.0.0.1");
    } finally {
      await rig.release();
    }
  });

  /**
   * K2/K3: the driver used to attach a job to whatever network was configured.
   * A non-internal one is refused now — and refused BEFORE a container exists,
   * so there is no window in which the job is on it.
   */
  it("refuses to run on a real, non-internal network", { timeout: 180_000 }, async () => {
    await createNetwork(OPEN, false);
    const rig = await itRunner({ egress: { networkName: OPEN, proxyUrl: DEAD_PROXY } });
    try {
      await expect(rig.shell("echo should-not-run")).rejects.toThrow(/not internal/);
      expect((await leftovers()).containers).toEqual([]);
    } finally {
      await rig.runner.release(rig.lease);
    }
  });

  it("refuses a network the daemon does not have", { timeout: 180_000 }, async () => {
    const rig = await itRunner({ egress: { networkName: `${IT_PREFIX}-missing`, proxyUrl: DEAD_PROXY } });
    try {
      await expect(rig.shell("echo should-not-run")).rejects.toThrow(RunnerConfigError);
    } finally {
      await rig.runner.release(rig.lease);
    }
  });

  it("refuses the namespace selectors outright — host is the whole runner host", async () => {
    const image = await itImage();
    for (const networkName of ["host", "none", "bridge", "default", "container:deadbeef"]) {
      expect(() =>
        createDockerLinuxRunner(
          {
            platforms: { "linux-node": { image, capacity: 1 } },
            egress: { networkName, proxyUrl: DEAD_PROXY },
          },
          { transport },
        ),
      ).toThrow(RunnerConfigError);
    }
  });
});
