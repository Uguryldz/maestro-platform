import { describe, expect, it } from "vitest";
import { LeaseLostError } from "../src/errors.js";
import { KillSwitchState } from "../src/kill-switch.js";
import { LeaseManager } from "../src/lease-manager.js";
import { FakePlatform } from "./fake-platform.js";
import { FakeClock, leasedJob } from "./helpers.js";

/**
 * Leasing (task #3). The property under test is the one that makes a crashed
 * agent safe: a claim EXPIRES, and an agent whose renewal is refused stops
 * before it can produce a second execution of the same ticket.
 *
 * Time is advanced by hand — nothing here sleeps.
 */

function harness(options: { renewMarginSeconds?: number } = {}): {
  clock: FakeClock;
  platform: FakePlatform;
  killSwitch: KillSwitchState;
  leases: LeaseManager;
} {
  const clock = new FakeClock();
  const platform = new FakePlatform();
  const killSwitch = new KillSwitchState();
  const leases = new LeaseManager({
    client: platform.client(),
    killSwitch,
    now: clock.now,
    sessionId: platform.sessionId,
    agentId: "mac-mini-07",
    renewMarginSeconds: options.renewMarginSeconds ?? 30,
  });
  return { clock, platform, killSwitch, leases };
}

describe("LeaseManager — expiry", () => {
  it("a lease past its deadline is dropped and reported", () => {
    const h = harness();
    h.leases.track(leasedJob({ leaseExpiresAt: h.clock.isoIn(60) }));
    expect(h.leases.isValid("lease-1")).toBe(true);

    h.clock.advanceSeconds(61);

    const dead = h.leases.expire();
    expect(dead.map((job) => job.leaseId)).toEqual(["lease-1"]);
    expect(h.leases.held()).toEqual([]);
    expect(h.leases.isValid("lease-1")).toBe(false);
  });

  it("assertHeld refuses a lease that has already expired", async () => {
    const h = harness();
    h.leases.track(leasedJob({ leaseExpiresAt: h.clock.isoIn(10) }));

    h.clock.advanceSeconds(11);

    await expect(h.leases.assertHeld("lease-1")).rejects.toThrow(LeaseLostError);
    // Dropped, so a retry cannot resurrect the claim.
    expect(h.leases.held()).toEqual([]);
    // It never even asked the platform: the deadline alone settles it.
    expect(h.platform.sent("/agent/lease/renew")).toEqual([]);
  });

  it("does not renew while the lease is comfortably in the future", async () => {
    const h = harness({ renewMarginSeconds: 30 });
    h.leases.track(leasedJob({ leaseExpiresAt: h.clock.isoIn(300) }));

    await h.leases.assertHeld("lease-1");

    expect(h.platform.sent("/agent/lease/renew")).toEqual([]);
  });

  it("renews once the lease enters the margin, and extends the deadline", async () => {
    const h = harness({ renewMarginSeconds: 30 });
    h.leases.track(leasedJob({ leaseExpiresAt: h.clock.isoIn(20) }));
    h.platform.renewExtendsToIso = h.clock.isoIn(320);

    await h.leases.assertHeld("lease-1");

    expect(h.platform.sent("/agent/lease/renew")).toHaveLength(1);
    h.clock.advanceSeconds(60);
    // Would have expired on the original deadline; the extension moved it.
    expect(h.leases.isValid("lease-1")).toBe(true);
  });

  it("a REFUSED renewal loses the lease — the job must stop", async () => {
    const h = harness({ renewMarginSeconds: 30 });
    h.leases.track(leasedJob({ leaseExpiresAt: h.clock.isoIn(20) }));
    h.platform.refuseRenewal.add("lease-1");

    await expect(h.leases.assertHeld("lease-1")).rejects.toThrow(LeaseLostError);
    expect(h.leases.held()).toEqual([]);
  });

  it("an undeliverable renewal leaves the deadline alone (fail-closed)", async () => {
    const h = harness({ renewMarginSeconds: 30 });
    h.leases.track(leasedJob({ leaseExpiresAt: h.clock.isoIn(20) }));
    h.platform.failing.add("/agent/lease/renew");

    // Does not throw: the agent may retry before the deadline.
    await h.leases.assertHeld("lease-1");

    // But the claim still runs out on schedule — a failed renewal is not a renewal.
    h.clock.advanceSeconds(21);
    expect(h.leases.isValid("lease-1")).toBe(false);
  });

  it("assertHeld refuses a lease the manager never held", async () => {
    const h = harness();
    await expect(h.leases.assertHeld("never-issued")).rejects.toThrow(LeaseLostError);
  });
});

describe("LeaseManager — kill switch delivery (task #5)", () => {
  it("applies the kill level carried on the renewal reply", async () => {
    const h = harness({ renewMarginSeconds: 30 });
    h.leases.track(leasedJob({ leaseExpiresAt: h.clock.isoIn(20) }));
    h.platform.killLevel = "stop_all";

    await h.leases.assertHeld("lease-1");

    // This is how a long-running build learns it must stop.
    expect(h.killSwitch.level).toBe("stop_all");
    expect(h.killSwitch.mayContinueRunning()).toBe(false);
  });
});

describe("LeaseManager — bookkeeping", () => {
  it("forget releases one lease and drain releases all of them", () => {
    const h = harness();
    h.leases.track(leasedJob({ leaseId: "lease-1", leaseExpiresAt: h.clock.isoIn(300) }));
    h.leases.track(leasedJob({ leaseId: "lease-2", leaseExpiresAt: h.clock.isoIn(300) }));
    expect(h.leases.size).toBe(2);

    h.leases.forget("lease-1");
    expect(h.leases.held()).toEqual(["lease-2"]);

    expect(h.leases.drain().map((job) => job.leaseId)).toEqual(["lease-2"]);
    expect(h.leases.size).toBe(0);
  });
});
