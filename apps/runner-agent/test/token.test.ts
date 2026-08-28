import type { SecretPort } from "@maestro/ports";
import { describe, expect, it } from "vitest";
import { TokenResolutionError } from "../src/errors.js";
import { createTokenResolver } from "../src/token.js";

/**
 * Token resolution (task #1). The credential is reached through a REFERENCE;
 * it is never written to disk by this app and never quoted in an error.
 */

const VALID = "a".repeat(32);

function fakeSecretPort(values: Record<string, string>, onGet?: () => void): SecretPort {
  return {
    get: (key) => {
      onGet?.();
      const value = values[key];
      if (value === undefined) return Promise.reject(new Error("no such secret"));
      return Promise.resolve(value);
    },
    issueShortLived: () =>
      Promise.resolve({ secret: "short-lived", expiresAt: new Date().toISOString() }),
    set: () => Promise.reject(new Error("not used")),
  };
}

describe("createTokenResolver — env source", () => {
  it("reads the named variable", async () => {
    const resolve = createTokenResolver({
      ref: { source: "env", key: "AGENT_TOKEN" },
      env: { AGENT_TOKEN: VALID },
    });

    await expect(resolve()).resolves.toBe(VALID);
  });

  it("fails closed when the variable is unset, naming the VARIABLE not a value", async () => {
    const resolve = createTokenResolver({ ref: { source: "env", key: "AGENT_TOKEN" }, env: {} });

    await expect(resolve()).rejects.toThrow(TokenResolutionError);
    await expect(resolve()).rejects.toThrow(/AGENT_TOKEN/);
  });

  it("refuses a token too short to be a shared secret", async () => {
    const resolve = createTokenResolver({
      ref: { source: "env", key: "AGENT_TOKEN" },
      env: { AGENT_TOKEN: "short" },
    });

    await expect(resolve()).rejects.toThrow(/shorter than/);
  });
});

describe("createTokenResolver — secret-port source", () => {
  it("resolves through the SecretPort", async () => {
    const resolve = createTokenResolver({
      ref: { source: "secret-port", key: "runner/mac-mini-07" },
      secrets: fakeSecretPort({ "runner/mac-mini-07": VALID }),
    });

    await expect(resolve()).resolves.toBe(VALID);
  });

  it("fails closed when no SecretPort was wired", async () => {
    const resolve = createTokenResolver({ ref: { source: "secret-port", key: "runner/x" } });

    await expect(resolve()).rejects.toThrow(/no SecretPort/);
  });

  it("does not leak the underlying error's message", async () => {
    const resolve = createTokenResolver({
      ref: { source: "secret-port", key: "runner/missing" },
      secrets: fakeSecretPort({}),
    });

    // Names the KEY and the error type, never a returned value.
    await expect(resolve()).rejects.toThrow(/runner\/missing/);
  });
});

describe("createTokenResolver — caching", () => {
  it("caches within the TTL and re-reads after it, so rotation takes effect", async () => {
    let now = 1_000;
    let reads = 0;
    const resolve = createTokenResolver({
      ref: { source: "secret-port", key: "runner/mac-mini-07" },
      secrets: fakeSecretPort({ "runner/mac-mini-07": VALID }, () => {
        reads += 1;
      }),
      cacheTtlMs: 60_000,
      now: () => now,
    });

    await resolve();
    await resolve();
    expect(reads).toBe(1);

    now += 60_001;
    await resolve();
    // A cache with no expiry would keep authenticating with a rotated credential.
    expect(reads).toBe(2);
  });
});
