import { describe, expect, it } from "vitest";
import { RetryPolicy } from "../src/config.js";
import { NotifyDeliveryError, NotifyPermanentError, NotifyTransientError } from "../src/errors.js";
import { backoffMs, sendToEachTarget, sendWithRetry } from "../src/retry.js";
import { fakeSleep } from "./helpers.js";

const POLICY = RetryPolicy.parse({ maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 });
const ctx = (sleep: (ms: number) => Promise<void>) => ({
  driver: "teams",
  event: "gate_open",
  policy: POLICY,
  sleep,
});

describe("delivery guarantee (spec §7)", () => {
  it("returns as soon as an attempt succeeds", async () => {
    const sleep = fakeSleep();
    let calls = 0;
    await sendWithRetry(ctx(sleep.sleep), async () => {
      calls += 1;
    });
    expect(calls).toBe(1);
    expect(sleep.waits).toEqual([]);
  });

  it("retries a transient failure up to maxAttempts, then reports it", async () => {
    const sleep = fakeSleep();
    let calls = 0;
    const error = await sendWithRetry(ctx(sleep.sleep), async () => {
      calls += 1;
      throw new NotifyTransientError("teams", "503");
    }).catch((caught: unknown) => caught);

    expect(calls).toBe(3);
    expect(sleep.waits).toEqual([100, 200]);
    expect(error).toBeInstanceOf(NotifyDeliveryError);
    expect((error as NotifyDeliveryError).attempts).toBe(3);
  });

  it("never retries a permanent failure", async () => {
    const sleep = fakeSleep();
    let calls = 0;
    await expect(
      sendWithRetry(ctx(sleep.sleep), async () => {
        calls += 1;
        throw new NotifyPermanentError("teams", "400");
      }),
    ).rejects.toBeInstanceOf(NotifyDeliveryError);
    expect(calls).toBe(1);
  });

  it("swallows nothing: an unknown error still surfaces", async () => {
    await expect(
      sendWithRetry(ctx(fakeSleep().sleep), async () => {
        throw new RangeError("bug in a driver");
      }),
    ).rejects.toThrow(/bug in a driver/);
  });

  it("caps the backoff and honours a longer Retry-After", () => {
    expect(backoffMs(POLICY, 1)).toBe(100);
    expect(backoffMs(POLICY, 4)).toBe(800);
    expect(backoffMs(POLICY, 5)).toBe(1_000);
    expect(backoffMs(POLICY, 1, 5_000)).toBe(1_000);
    expect(backoffMs(POLICY, 1, 10)).toBe(100);
  });
});

describe("fan-out to several targets", () => {
  it("attempts every target even after one fails, then reports all failures", async () => {
    const attempted: string[] = [];
    const error = await sendToEachTarget(ctx(fakeSleep().sleep), ["a", "b", "c"], async (target) => {
      attempted.push(target);
      if (target !== "b") throw new NotifyPermanentError("teams", `${target} is dead`);
    }).catch((caught: unknown) => caught);

    expect(attempted).toEqual(["a", "b", "c"]);
    expect(String(error)).toMatch(/2 of 3 target\(s\) failed/);
    expect(String(error)).toContain("a:");
    expect(String(error)).toContain("c:");
  });

  it("stays silent when every target succeeds", async () => {
    await expect(sendToEachTarget(ctx(fakeSleep().sleep), ["a", "b"], async () => {})).resolves.toBeUndefined();
  });
});
