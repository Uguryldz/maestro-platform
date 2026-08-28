import { describe, expect, it } from "vitest";
import { RunnerCapacityError, RunnerLeaseError } from "../src/errors.js";
import { RunnerPool } from "../src/pool.js";
import { sequentialIds } from "./helpers.js";

function pool(capacity = 2) {
  return new RunnerPool(
    { "linux-node": { image: "sha256:" + "a".repeat(64), capacity } },
    sequentialIds(),
  );
}

describe("capacity (M21)", () => {
  it("hands out one lease per slot and then fails closed", () => {
    const slots = pool(2);

    const first = slots.acquire("linux-node");
    const second = slots.acquire("linux-node");

    expect(first.runnerId).not.toBe(second.runnerId);
    expect(() => slots.acquire("linux-node")).toThrow(RunnerCapacityError);
  });

  it("never hands the same runner to two leases", () => {
    const slots = pool(3);
    const ids = [slots.acquire("linux-node"), slots.acquire("linux-node"), slots.acquire("linux-node")];

    expect(new Set(ids.map((lease) => lease.runnerId)).size).toBe(3);
    expect(new Set(ids.map((lease) => lease.leaseId)).size).toBe(3);
  });

  it("refuses a platform it has no slots for", () => {
    expect(() => pool(1).acquire("linux-android")).toThrow(RunnerCapacityError);
  });

  it("reports what it is doing", () => {
    const slots = pool(2);
    const lease = slots.acquire("linux-node");
    slots.beginSession(lease);

    expect(slots.snapshot()).toEqual([{ platform: "linux-node", capacity: 2, leased: 1, running: 1 }]);
  });
});

describe("lease validity", () => {
  it("refuses an unknown lease", () => {
    const slots = pool();

    expect(() => slots.slotOf({ leaseId: "nope", runnerId: "docker-linux/linux-node/0", platform: "linux-node" }))
      .toThrow(new RunnerLeaseError("nope", "unknown").message);
  });

  it("tells a released lease apart from one that never existed", () => {
    const slots = pool();
    const lease = slots.acquire("linux-node");
    slots.release(lease);

    expect(() => slots.slotOf(lease)).toThrow(/released/);
  });

  it("refuses a lease whose runner or platform was tampered with", () => {
    const slots = pool();
    const lease = slots.acquire("linux-node");

    expect(() => slots.slotOf({ ...lease, runnerId: "docker-linux/linux-node/9" })).toThrow(/foreign/);
    expect(() => slots.slotOf({ ...lease, platform: "linux-android" })).toThrow(/foreign/);
  });

  it("refuses a second session on a busy lease", () => {
    const slots = pool();
    const lease = slots.acquire("linux-node");
    slots.beginSession(lease);

    expect(() => slots.beginSession(lease)).toThrow(/busy/);

    slots.endSession(lease);
    expect(() => slots.beginSession(lease)).not.toThrow();
  });
});

describe("release is idempotent (port contract)", () => {
  it("frees the slot once and answers false afterwards", () => {
    const slots = pool(1);
    const lease = slots.acquire("linux-node");

    expect(slots.release(lease)).toBe(true);
    expect(slots.release(lease)).toBe(false);
    expect(slots.release(lease)).toBe(false);
    expect(slots.snapshot()[0]).toMatchObject({ leased: 0, running: 0 });
  });

  it("does not throw for a lease it never issued — cleanup paths run twice", () => {
    expect(pool().release({ leaseId: "ghost", runnerId: "r", platform: "linux-node" })).toBe(false);
  });

  it("returns the slot to the free pool, with no cache left attached", () => {
    const slots = pool(1);
    const first = slots.acquire("linux-node");
    slots.attachCache(first, ["dep-a"]);
    slots.release(first);

    const second = slots.acquire("linux-node");

    expect(second.runnerId).toBe(first.runnerId);
    expect(slots.slotOf(second).cacheKeys).toEqual([]);
  });

  it("clears the running flag so a released slot is reusable after a crash", () => {
    const slots = pool(1);
    const lease = slots.acquire("linux-node");
    slots.beginSession(lease);
    slots.release(lease);

    expect(slots.snapshot()[0]).toMatchObject({ running: 0, leased: 0 });
  });
});

describe("cache attachment", () => {
  it("accumulates keys without duplicates", () => {
    const slots = pool();
    const lease = slots.acquire("linux-node");

    slots.attachCache(lease, ["dep-a"]);
    const keys = slots.attachCache(lease, ["dep-a", "dep-b"]);

    expect(keys).toEqual(["dep-a", "dep-b"]);
  });

  it("refuses to attach to a released lease", () => {
    const slots = pool();
    const lease = slots.acquire("linux-node");
    slots.release(lease);

    expect(() => slots.attachCache(lease, ["dep-a"])).toThrow(RunnerLeaseError);
  });
});
