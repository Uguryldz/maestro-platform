import { describe, expect, it } from "vitest";
import {
  RateLimitConfig,
  RetryConfig,
  TokenBucket,
  classifyNetworkFailure,
  collectFailureCodes,
  networkFailureSummary,
  postJson,
} from "../src/index.js";
import { fakeClock } from "./helpers.js";

/**
 * The cause classifier: the difference between "unreachable" and the four
 * distinct repairs an operator can actually perform. Node's fetch (undici)
 * hides the real reason in `error.cause` — these tests pin that the walk finds
 * it wherever undici puts it, and that NOTHING from an error's message (where
 * a URL or a header could sit) ever comes out of the classifier.
 */

/** The shape undici actually throws: a generic wrapper with the truth inside. */
function fetchFailed(cause: unknown): TypeError {
  const error = new TypeError("fetch failed");
  (error as { cause?: unknown }).cause = cause;
  return error;
}

describe("collectFailureCodes", () => {
  it("walks the cause chain and an AggregateError's members", () => {
    // Dual-stack dials produce one error per address, wrapped in an
    // AggregateError — the refused code must be found INSIDE it.
    const aggregate = new AggregateError([
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:19777"), { code: "ECONNREFUSED" }),
      Object.assign(new Error("connect ECONNREFUSED [::1]:19777"), { code: "ECONNREFUSED" }),
    ]);
    expect(collectFailureCodes(fetchFailed(aggregate))).toEqual(["ECONNREFUSED"]);
  });

  it("reads codes, dedupes, and never reads a message", () => {
    const inner = Object.assign(new Error("secret-token-in-message"), { code: "ENOTFOUND" });
    const codes = collectFailureCodes(fetchFailed(inner));
    expect(codes).toEqual(["ENOTFOUND"]);
    expect(codes.join(" ")).not.toContain("secret");
  });

  it("survives a cyclic cause chain", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    a.cause = a;
    expect(collectFailureCodes(a)).toEqual([]);
  });

  it("recognises an AbortSignal.timeout rejection by NAME (its code is numeric)", () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect(collectFailureCodes(timeout)).toEqual(["TimeoutError"]);
  });
});

describe("classifyNetworkFailure", () => {
  it.each([
    ["ENOTFOUND", "dns"],
    ["EAI_AGAIN", "dns"],
    ["ECONNREFUSED", "refused"],
    ["ETIMEDOUT", "timeout"],
    ["UND_ERR_CONNECT_TIMEOUT", "timeout"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "tls"],
    ["SELF_SIGNED_CERT_IN_CHAIN", "tls"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "tls"],
    ["CERT_HAS_EXPIRED", "tls"],
    ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "tls"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "tls"],
  ] as const)("maps %s to kind %s", (code, kind) => {
    const failure = classifyNetworkFailure(fetchFailed(Object.assign(new Error("x"), { code })));
    expect(failure.kind).toBe(kind);
    expect(failure.code).toBe(code);
  });

  it("prefers the TLS diagnosis when several codes share the chain", () => {
    // A retried handshake can leave both a socket code and the cert code on
    // one chain; "your CA is not trusted" is the one with the concrete fix.
    const socket = Object.assign(new Error("s"), { code: "ECONNRESET" }) as Error & { cause?: unknown };
    socket.cause = Object.assign(new Error("c"), { code: "SELF_SIGNED_CERT_IN_CHAIN" });
    expect(classifyNetworkFailure(fetchFailed(socket)).kind).toBe("tls");
  });

  it("stays null for codes it does not know — the caller keeps its honest last resort", () => {
    const failure = classifyNetworkFailure(fetchFailed(Object.assign(new Error("x"), { code: "EPIPE" })));
    expect(failure.kind).toBeNull();
    expect(failure.codes).toEqual(["EPIPE"]);
  });
});

describe("networkFailureSummary", () => {
  it("names the TLS repair this deployment actually has (NODE_EXTRA_CA_CERTS)", () => {
    const summary = networkFailureSummary(
      fetchFailed(Object.assign(new Error("x"), { code: "SELF_SIGNED_CERT_IN_CHAIN" })),
    );
    expect(summary).toContain("TLS sertifikası doğrulanamadı");
    expect(summary).toContain("SELF_SIGNED_CERT_IN_CHAIN");
    expect(summary).toContain("NODE_EXTRA_CA_CERTS");
  });

  it("is null when there is nothing trustworthy to say", () => {
    expect(networkFailureSummary(new Error("just prose"))).toBeNull();
  });
});

describe("postJson transport errors carry the classification", () => {
  it("puts the cause into the error MESSAGE, where String(error) → the run journal reads it", async () => {
    const clock = fakeClock();
    const cause = Object.assign(new Error("unable to verify the first certificate"), {
      code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    });
    const context = {
      deps: {
        fetchImpl: () => Promise.reject(fetchFailed(cause)),
        sleep: () => Promise.resolve(),
        now: clock.now,
        random: () => 0.5,
      },
      bucket: new TokenBucket(RateLimitConfig.parse({}), clock.now),
      retry: RetryConfig.parse({ maxAttempts: 1 }),
    };
    // A PUBLIC-shaped host on purpose: an internal one (`.local`, RFC1918)
    // would take the TLS auto-skip path and dial for real instead of hitting
    // the injected stub.
    const request = { driver: "openai-compat", url: "https://llm.ugurbank.example/v1/chat/completions", headers: {}, body: {}, timeoutMs: 1_000 };

    await expect(postJson(request, context)).rejects.toThrow(
      /transport error — TLS sertifikası doğrulanamadı \(UNABLE_TO_VERIFY_LEAF_SIGNATURE\)/,
    );
  });
});
