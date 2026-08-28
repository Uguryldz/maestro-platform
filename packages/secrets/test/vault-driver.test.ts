import { describe, expect, it } from "vitest";
import {
  createVaultSecretPort,
  SecretConfigError,
  SecretError,
  SecretExpiredError,
  SecretKeyError,
  SecretNotFoundError,
  SecretPermissionDeniedError,
  SecretTtlError,
  VaultResponseError,
  VaultSealedError,
} from "../src/index.js";
import { APPROLE, type FakeClock, fakeClock, fixture, type StubResponse, stubFetch, T0, VAULT_CONFIG, withLogin } from "./helpers.js";

function driver(responses: StubResponse[], clock: FakeClock = fakeClock(), overrides: Record<string, unknown> = {}) {
  const stub = stubFetch(responses);
  const port = createVaultSecretPort({
    ...VAULT_CONFIG,
    ...overrides,
    deps: { approle: APPROLE, fetchImpl: stub.fetchImpl, clock: clock.clock },
  });
  return { stub, port, clock };
}

describe("vault driver get()", () => {
  it("reads a KV v2 field through the data/ prefix", async () => {
    const { stub, port } = driver(withLogin([{ body: fixture("kv-read") }]));

    await expect(port.get("kv/jira/pat#token")).resolves.toBe("s.JIRA-PAT-NAMED-FIELD-VALUE");
    expect(stub.calls[1]!.url).toBe("https://vault.internal.bank/v1/kv/data/jira/pat");
  });

  it("uses the default field when the key has no #suffix", async () => {
    const { port } = driver(withLogin([{ body: fixture("kv-read") }]));

    await expect(port.get("kv/jira/pat")).resolves.toBe("s.JIRA-PAT-DEFAULT-FIELD-VALUE");
  });

  it("caches within the TTL and re-reads after it", async () => {
    const clock = fakeClock();
    const { stub, port } = driver(
      withLogin([{ body: fixture("kv-read") }, { body: fixture("kv-read") }]),
      clock,
      { cacheTtlSeconds: 30 },
    );

    await port.get("kv/jira/pat#token");
    clock.advance(29_000);
    await port.get("kv/jira/pat#token");
    expect(stub.calls).toHaveLength(2); // login + one read

    clock.advance(2_000);
    await port.get("kv/jira/pat#token");
    expect(stub.calls).toHaveLength(3);
  });

  it("invalidate() forces the next read to hit Vault", async () => {
    const { stub, port } = driver(
      withLogin([{ body: fixture("kv-read") }, { body: fixture("kv-read") }]),
      fakeClock(),
      { cacheTtlSeconds: 30 },
    );

    await port.get("kv/jira/pat#token");
    port.invalidate();
    await port.get("kv/jira/pat#token");

    expect(stub.calls).toHaveLength(3);
  });

  it("maps 404 to SecretNotFoundError", async () => {
    const { port } = driver(withLogin([{ status: 404, body: fixture("kv-deleted") }]));

    await expect(port.get("kv/jira/pat#token")).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it("maps 403 to SecretPermissionDeniedError", async () => {
    const { port } = driver(withLogin([{ status: 403, body: fixture("error-permission-denied") }]));

    await expect(port.get("kv/jira/pat#token")).rejects.toBeInstanceOf(SecretPermissionDeniedError);
  });

  it("maps 503 to VaultSealedError — sealed is not the same as denied", async () => {
    const { port } = driver(withLogin([{ status: 503, body: fixture("error-sealed") }]));

    await expect(port.get("kv/jira/pat#token")).rejects.toBeInstanceOf(VaultSealedError);
  });

  it("treats a missing or empty field as absent (M6: no placeholder secrets)", async () => {
    const { port } = driver(withLogin([{ body: fixture("kv-read") }, { body: fixture("kv-read") }]));

    await expect(port.get("kv/jira/pat#absent")).rejects.toBeInstanceOf(SecretNotFoundError);
    await expect(port.get("kv/jira/pat#blank")).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it("refuses a mount outside the allow-list before any request", async () => {
    const { stub, port } = driver([]);

    await expect(port.get("root/jira/pat")).rejects.toBeInstanceOf(SecretPermissionDeniedError);
    expect(stub.calls).toHaveLength(0);
  });

  it("refuses a malformed key before any request", async () => {
    const { stub, port } = driver([]);

    await expect(port.get("kv/../auth/token")).rejects.toBeInstanceOf(SecretKeyError);
    expect(stub.calls).toHaveLength(0);
  });
});

describe("vault driver issueShortLived() — M31", () => {
  it("reads the dynamic path with the requested ttl and returns the lease deadline", async () => {
    const { stub, port } = driver(withLogin([{ body: fixture("dynamic-creds") }]));

    const issued = await port.issueShortLived("repo/ugurpay-core/push", 600);

    expect(stub.calls[1]!.url).toBe(
      "https://vault.internal.bank/v1/git/creds/repo/ugurpay-core/push?ttl=600s",
    );
    expect(issued.secret).toBe("ghs.SHORT-LIVED-PUSH-TOKEN");
    expect(issued.expiresAt).toBe(new Date(T0 + 600_000).toISOString());
  });

  it("honours the lease Vault actually granted, not the one requested", async () => {
    const short = structuredClone(fixture("dynamic-creds")) as Record<string, unknown>;
    short["lease_duration"] = 120;
    const { port } = driver(withLogin([{ body: short }]));

    const issued = await port.issueShortLived("repo/ugurpay-core/push", 600);

    expect(issued.expiresAt).toBe(new Date(T0 + 120_000).toISOString());
  });

  it("rejects a ttl above the configured ceiling instead of clamping it", async () => {
    const { stub, port } = driver([]);

    await expect(port.issueShortLived("repo/ugurpay-core/push", 901)).rejects.toBeInstanceOf(SecretTtlError);
    expect(stub.calls).toHaveLength(0);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects the non-positive/non-integer ttl %s", async (ttl) => {
    const { port } = driver([]);

    await expect(port.issueShortLived("repo/ugurpay-core/push", ttl)).rejects.toBeInstanceOf(SecretTtlError);
  });

  it("refuses a scope that tries to escape the configured prefix", async () => {
    const { stub, port } = driver([]);

    await expect(port.issueShortLived("../../auth/token/create", 60)).rejects.toBeInstanceOf(SecretKeyError);
    expect(stub.calls).toHaveLength(0);
  });

  it("never returns an already-expired credential", async () => {
    const expired = structuredClone(fixture("dynamic-creds")) as Record<string, unknown>;
    expired["lease_duration"] = 0;
    const { port } = driver(withLogin([{ body: expired }]));

    await expect(port.issueShortLived("repo/ugurpay-core/push", 600)).rejects.toBeInstanceOf(SecretExpiredError);
  });

  it("rejects a response without the configured credential field", async () => {
    const noToken = structuredClone(fixture("dynamic-creds")) as { data: Record<string, unknown> };
    delete noToken.data["token"];
    const { port } = driver(withLogin([{ body: noToken }]));

    await expect(port.issueShortLived("repo/ugurpay-core/push", 600)).rejects.toBeInstanceOf(VaultResponseError);
  });

  it("propagates a denied issuance path", async () => {
    const { port } = driver(withLogin([{ status: 403, body: fixture("error-permission-denied") }]));

    await expect(port.issueShortLived("repo/ugurpay-core/push", 600)).rejects.toBeInstanceOf(
      SecretPermissionDeniedError,
    );
  });

  it("issues for a real Azure DevOps project name (spaces and all)", async () => {
    const { stub, port } = driver(withLogin([{ body: fixture("dynamic-creds") }]));

    await port.issueShortLived("ado/Core Banking/core-api/push", 600);

    expect(stub.calls[1]!.url).toBe(
      "https://vault.internal.bank/v1/git/creds/ado/Core%20Banking/core-api/push?ttl=600s",
    );
  });

  it("is never served from the cache — two calls hit Vault twice", async () => {
    const { stub, port } = driver(
      withLogin([{ body: fixture("dynamic-creds") }, { body: fixture("dynamic-creds") }]),
      fakeClock(),
      { cacheTtlSeconds: 300 },
    );

    await port.issueShortLived("repo/ugurpay-core/push", 600);
    await port.issueShortLived("repo/ugurpay-core/push", 600);

    expect(stub.calls).toHaveLength(3);
  });
});

/**
 * The M31 ceiling is a property of the credential the caller ENDS UP HOLDING,
 * not only of the request: a Vault role whose own ttl outlives the ceiling must
 * not be able to hand a long-lived push token back through this driver.
 */
describe("vault driver issueShortLived() — the granted lease is capped too", () => {
  function withLease(lease: unknown): Record<string, unknown> {
    const body = structuredClone(fixture("dynamic-creds")) as Record<string, unknown>;
    if (lease === undefined) delete body["lease_duration"];
    else body["lease_duration"] = lease;
    return body;
  }

  it("refuses a granted lease above the ceiling even though the request was inside it", async () => {
    const { port } = driver(withLogin([{ body: withLease(86_400) }]));

    const error = await port.issueShortLived("repo/ugurpay-core/push", 600).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SecretTtlError);
    expect((error as Error).message).toContain("86400");
  });

  it("refuses a granted lease just over the ceiling, even inside the skew allowance", async () => {
    const { port } = driver(withLogin([{ body: withLease(930) }]));

    // 930s is within 900 + 60s of the request, so only the M31 ceiling catches it.
    const error = await port.issueShortLived("repo/ugurpay-core/push", 900).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SecretTtlError);
    expect((error as Error).message).toContain("above the ceiling");
  });

  it("refuses a granted lease that outlives the requested window", async () => {
    const { port } = driver(withLogin([{ body: withLease(800) }]));

    await expect(port.issueShortLived("repo/ugurpay-core/push", 600)).rejects.toBeInstanceOf(SecretTtlError);
  });

  it("tolerates a granted lease inside the clock-skew allowance", async () => {
    const { port } = driver(withLogin([{ body: withLease(630) }]));

    await expect(port.issueShortLived("repo/ugurpay-core/push", 600)).resolves.toEqual({
      secret: "ghs.SHORT-LIVED-PUSH-TOKEN",
      expiresAt: new Date(T0 + 630_000).toISOString(),
    });
  });

  it("never guesses an expiry when Vault omits lease_duration", async () => {
    const { port } = driver(withLogin([{ body: withLease(undefined) }]));

    await expect(port.issueShortLived("repo/ugurpay-core/push", 600)).rejects.toBeInstanceOf(VaultResponseError);
  });

  it.each([
    [1e18, "absurd lease"],
    [Number.MAX_SAFE_INTEGER, "max safe integer"],
    [1.5, "fractional lease"],
    ["600", "string lease"],
    [null, "null lease"],
    [Number.NaN, "NaN lease"],
    [Number.POSITIVE_INFINITY, "infinite lease"],
  ])("turns an unusable lease_duration (%s) into a typed secret failure", async (lease, _label) => {
    const { port } = driver(withLogin([{ body: withLease(lease) }]));

    const error = await port.issueShortLived("repo/ugurpay-core/push", 600).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SecretError);
    expect(error).not.toBeInstanceOf(RangeError);
  });
});

describe("vault driver construction", () => {
  it("refuses a shortLived mount that is not in the allow-list", () => {
    expect(() =>
      driver([], fakeClock(), { allowedMounts: ["kv"] }),
    ).toThrow(SecretConfigError);
  });

  it("refuses to build without AppRole material", () => {
    expect(() => createVaultSecretPort({ ...VAULT_CONFIG, deps: {} })).toThrow(SecretConfigError);
  });
});
