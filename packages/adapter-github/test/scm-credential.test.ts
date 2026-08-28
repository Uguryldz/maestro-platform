import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_PUSH_TTL_SECONDS, GithubResponseError, pushScope } from "../src/index.js";
import { issuer, NOW_MS, REPO, scmDriver as driver } from "./helpers.js";

const TEN_YEARS_SECONDS = 10 * 365 * 24 * 3600;

/** Issues a credential with a fixed expiry, whatever the requested ttl. */
function issuerExpiringAt(expiresAt: string) {
  return () => Promise.resolve({ secret: "ghs-ephemeral", expiresAt });
}

describe("GithubScmDriver.getPushCredential", () => {
  it("passes the issued short-lived credential through under a stable scope", async () => {
    const scopes: string[] = [];
    const { scm, calls } = driver(() => ({ json: {} }), {
      issueSecret: (scope, ttl) => {
        scopes.push(scope);
        return issuer(scope, ttl);
      },
    });
    const credential = await scm.getPushCredential(REPO, 900);

    expect(credential.token).toBe("ghs-ephemeral-installation-token");
    expect(credential.expiresAt).toBe("2026-08-08T12:15:00.000Z");
    expect(scopes).toEqual([pushScope(REPO)]);
    expect(pushScope(REPO)).toBe("github/ugurbank/ugurpay/push");
    // No REST call: the credential comes from the SecretPort, not from GitHub.
    expect(calls).toHaveLength(0);
  });

  it("rejects a non-positive or fractional ttl", async () => {
    const { scm } = driver(() => ({ json: {} }));
    await expect(scm.getPushCredential(REPO, 0)).rejects.toBeInstanceOf(GithubResponseError);
    await expect(scm.getPushCredential(REPO, -60)).rejects.toBeInstanceOf(GithubResponseError);
    await expect(scm.getPushCredential(REPO, 1.5)).rejects.toBeInstanceOf(GithubResponseError);
  });

  it("rejects an issuer that returns an empty secret or a bad expiry", async () => {
    const empty = driver(() => ({ json: {} }), {
      issueSecret: () => Promise.resolve({ secret: "", expiresAt: "2026-08-08T12:05:00.000Z" }),
    });
    await expect(empty.scm.getPushCredential(REPO, 600)).rejects.toThrow(/empty secret/);

    const badExpiry = driver(() => ({ json: {} }), { issueSecret: issuerExpiringAt("soon") });
    await expect(badExpiry.scm.getPushCredential(REPO, 60)).rejects.toThrow(/expiresAt/);
  });
});

describe("GithubScmDriver.getPushCredential short-lived enforcement (O5/M31)", () => {
  it("refuses a ttl above the default one-hour ceiling", async () => {
    const { scm } = driver(() => ({ json: {} }));
    await expect(scm.getPushCredential(REPO, TEN_YEARS_SECONDS)).rejects.toThrow(/ceiling/);
    await expect(
      scm.getPushCredential(REPO, DEFAULT_MAX_PUSH_TTL_SECONDS + 1),
    ).rejects.toBeInstanceOf(GithubResponseError);
    await expect(scm.getPushCredential(REPO, DEFAULT_MAX_PUSH_TTL_SECONDS)).resolves.toMatchObject({
      token: "ghs-ephemeral-installation-token",
    });
  });

  it("never calls the issuer for a ttl over the ceiling", async () => {
    let issued = 0;
    const { scm } = driver(() => ({ json: {} }), {
      issueSecret: (scope, ttl) => {
        issued += 1;
        return issuer(scope, ttl);
      },
    });
    await expect(scm.getPushCredential(REPO, TEN_YEARS_SECONDS)).rejects.toThrow();
    expect(issued).toBe(0);
  });

  it("honours a lower ceiling from the driver config", async () => {
    const { scm } = driver(() => ({ json: {} }), { maxPushTtlSeconds: 300 });
    await expect(scm.getPushCredential(REPO, 900)).rejects.toThrow(/300s ceiling/);
    await expect(scm.getPushCredential(REPO, 300)).resolves.toMatchObject({
      expiresAt: "2026-08-08T12:05:00.000Z",
    });
  });

  it("refuses a credential that has already expired (fine-grained PAT trap)", async () => {
    // A fixed-expiry PAT that already lapsed must fail closed, not pass through.
    const { scm } = driver(() => ({ json: {} }), {
      issueSecret: issuerExpiringAt("2020-01-01T00:00:00.000Z"),
    });
    await expect(scm.getPushCredential(REPO, 900)).rejects.toThrow(/already-expired/);
  });

  it("refuses a credential that outlives the ttl it was issued for", async () => {
    // A far-off fine-grained PAT expiry is exactly this failure: minted for a
    // year against a 60s request. The GitHub App installation token is the
    // hardened path (see RAPOR).
    const { scm } = driver(() => ({ json: {} }), {
      issueSecret: issuerExpiringAt(new Date(NOW_MS + 365 * 86_400_000).toISOString()),
    });
    await expect(scm.getPushCredential(REPO, 60)).rejects.toThrow(/outlives its 60s ttl/);
  });

  it("tolerates a minute of clock skew between issuer and adapter", async () => {
    const withinSkew = driver(() => ({ json: {} }), {
      issueSecret: issuerExpiringAt(new Date(NOW_MS + (600 + 30) * 1000).toISOString()),
    });
    await expect(withinSkew.scm.getPushCredential(REPO, 600)).resolves.toMatchObject({
      token: "ghs-ephemeral",
    });

    const beyondSkew = driver(() => ({ json: {} }), {
      issueSecret: issuerExpiringAt(new Date(NOW_MS + (600 + 61) * 1000).toISOString()),
    });
    await expect(beyondSkew.scm.getPushCredential(REPO, 600)).rejects.toThrow(/outlives/);
  });
});
