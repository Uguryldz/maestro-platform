import { describe, expect, it } from "vitest";
import {
  CallCounter,
  LlmAuthError,
  LlmHttpError,
  LlmRateLimitError,
  LlmResponseError,
  RateLimitConfig,
  RetryConfig,
  TokenBucket,
  postJson,
} from "../src/index.js";
import { type FetchStub, fakeClock, stubFetch } from "./helpers.js";

const clock = () => fakeClock();

function context(stub: FetchStub, now: () => Date, retry: Record<string, unknown> = {}, rate: Record<string, unknown> = {}) {
  return {
    deps: { fetchImpl: stub.fetchImpl, sleep: stub.sleep, now, random: () => 0.5 },
    bucket: new TokenBucket(RateLimitConfig.parse(rate), now),
    retry: RetryConfig.parse(retry),
  };
}

const request = { driver: "anthropic-direct", url: "https://api.test/v1/messages", headers: {}, body: { a: 1 }, timeoutMs: 1_000 };

describe("TokenBucket (M19)", () => {
  it("serves the burst capacity immediately, then reports the wait", () => {
    const c = clock();
    const bucket = new TokenBucket(RateLimitConfig.parse({ capacity: 2, refillPerSecond: 2 }), c.now);

    expect(bucket.take()).toBe(0);
    expect(bucket.take()).toBe(0);
    expect(bucket.take()).toBe(500);
  });

  it("refills over time and never exceeds the capacity", () => {
    const c = clock();
    const bucket = new TokenBucket(RateLimitConfig.parse({ capacity: 2, refillPerSecond: 2 }), c.now);
    bucket.take();
    bucket.take();

    c.advance(1_000);
    expect(bucket.take()).toBe(0);
    expect(bucket.take()).toBe(0);
    expect(bucket.take()).toBe(500);

    c.advance(60_000);
    expect(bucket.take()).toBe(0);
    expect(bucket.take()).toBe(0);
    expect(bucket.take()).toBe(500);
  });
});

describe("postJson", () => {
  it("posts JSON with the caller's headers and returns the parsed body", async () => {
    const stub = stubFetch([{ body: { ok: true } }]);
    const c = clock();

    const json = await postJson({ ...request, headers: { "x-api-key": "k" } }, context(stub, c.now));

    expect(json).toEqual({ ok: true });
    expect(stub.calls[0]).toMatchObject({
      method: "POST",
      url: "https://api.test/v1/messages",
      headers: { "x-api-key": "k", "content-type": "application/json" },
      body: { a: 1 },
    });
  });

  it("waits for the rate limiter before the call", async () => {
    const stub = stubFetch([{ body: {} }, { body: {} }]);
    const c = clock();
    const ctx = context(stub, c.now, {}, { capacity: 1, refillPerSecond: 1 });

    await postJson(request, ctx);
    await postJson(request, ctx);

    expect(stub.sleeps).toEqual([1_000]);
  });

  it("retries a 429 with exponential backoff and succeeds", async () => {
    const stub = stubFetch([{ status: 429, body: { error: "slow down" } }, { body: { ok: true } }]);
    const c = clock();

    await expect(postJson(request, context(stub, c.now))).resolves.toEqual({ ok: true });
    expect(stub.sleeps).toEqual([500]);
    expect(stub.calls).toHaveLength(2);
  });

  it("honours Retry-After over the exponential backoff, capped by maxDelayMs", async () => {
    const stub = stubFetch([{ status: 429, headers: { "retry-after": "30" }, body: {} }, { body: { ok: true } }]);
    const c = clock();

    await postJson(request, context(stub, c.now, { maxDelayMs: 4_000 }));
    expect(stub.sleeps).toEqual([4_000]);
  });

  it("gives up after maxAttempts and raises a rate limit error", async () => {
    const stub = stubFetch([
      { status: 429, headers: { "retry-after": "1" }, body: {} },
      { status: 429, headers: { "retry-after": "1" }, body: {} },
    ]);
    const c = clock();

    const error = await postJson(request, context(stub, c.now, { maxAttempts: 2 })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmRateLimitError);
    expect((error as LlmRateLimitError).retryAfterMs).toBe(1_000);
    expect(stub.sleeps).toEqual([1_000]);
  });

  it("retries 5xx and transport errors, but not 4xx", async () => {
    const c = clock();
    const serverError = stubFetch([{ status: 503, body: {} }, { body: { ok: true } }]);
    await expect(postJson(request, context(serverError, c.now))).resolves.toEqual({ ok: true });

    const transport = stubFetch([{ throws: "ECONNRESET" }, { body: { ok: true } }]);
    await expect(postJson(request, context(transport, c.now))).resolves.toEqual({ ok: true });

    const badRequest = stubFetch([{ status: 400, body: { error: "bad model" } }]);
    await expect(postJson(request, context(badRequest, c.now))).rejects.toBeInstanceOf(LlmHttpError);
    expect(badRequest.calls).toHaveLength(1);
  });

  it("never retries 401/403 — a revoked key is not congestion", async () => {
    const c = clock();
    for (const status of [401, 403]) {
      const stub = stubFetch([{ status, body: { error: "nope" } }]);
      const error = await postJson(request, context(stub, c.now)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LlmAuthError);
      expect((error as LlmAuthError).status).toBe(status);
      expect(stub.calls).toHaveLength(1);
      expect(stub.sleeps).toEqual([]);
    }
  });

  it("does not sleep after the final attempt", async () => {
    const stub = stubFetch([{ throws: "ECONNRESET" }, { throws: "ECONNRESET" }]);
    const c = clock();

    await expect(postJson(request, context(stub, c.now, { maxAttempts: 2 }))).rejects.toThrow(/transport error/);
    expect(stub.sleeps).toEqual([500]);
  });

  it("applies deterministic jitter from the injected random source", async () => {
    const stub = stubFetch([{ status: 500, body: {} }, { body: { ok: true } }]);
    const c = clock();
    const ctx = context(stub, c.now, { jitterRatio: 0.5 });
    ctx.deps.random = () => 1; // maximum positive jitter

    await postJson(request, ctx);
    expect(stub.sleeps).toEqual([750]);
  });

  it("rejects a 2xx body that is empty or not JSON", async () => {
    const c = clock();
    await expect(postJson(request, context(stubFetch([{ raw: "" }]), c.now))).rejects.toBeInstanceOf(LlmResponseError);
    await expect(postJson(request, context(stubFetch([{ raw: "<html>oops</html>" }]), c.now))).rejects.toThrow(
      /not JSON/,
    );
  });

  it("keeps a truncated error body for the audit trail", async () => {
    const stub = stubFetch([{ status: 400, raw: "x".repeat(900) }]);
    const c = clock();

    const error = (await postJson(request, context(stub, c.now)).catch((e: unknown) => e)) as LlmHttpError;
    expect(error.responseBody).toHaveLength(500);
    expect(error.status).toBe(400);
  });
});

/**
 * B6: a logical gateway call costs one quota unit per PHYSICAL provider call.
 * The count is an out-parameter because the failure path is where the retries
 * pile up — a return value would be lost exactly when it matters most.
 */
describe("CallCounter (M55 quota accounting)", () => {
  it("counts every physical attempt, retries included", async () => {
    const counter = new CallCounter();
    const stub = stubFetch([{ status: 503, body: { e: 1 } }, { status: 503, body: { e: 1 } }, { body: { ok: true } }]);
    const c = clock();

    await postJson(request, { ...context(stub, c.now, { baseDelayMs: 1 }), counter });
    expect(counter.attempts).toBe(3);
  });

  it("still knows the attempt count when the call ends in a throw", async () => {
    const counter = new CallCounter();
    const stub = stubFetch([{ throws: "ECONNRESET" }, { throws: "ECONNRESET" }, { throws: "ECONNRESET" }]);
    const c = clock();

    await expect(postJson(request, { ...context(stub, c.now, { baseDelayMs: 1 }), counter })).rejects.toThrow(
      /transport error/,
    );
    expect(counter.attempts).toBe(3);
  });

  it("counts nothing when the call was never issued", () => {
    expect(new CallCounter().attempts).toBe(0);
  });
});
