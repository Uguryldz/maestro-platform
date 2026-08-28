import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { createEnvFileSecretPort, createVaultSecretPort, TtlCache, VaultConfig } from "../src/index.js";
import { VaultClient } from "../src/vault-client.js";
import {
  APPROLE,
  ENV_FILE_CONFIG,
  fakeClock,
  fixture,
  SECRET_VALUES,
  type StubResponse,
  stubFetch,
  VAULT_CONFIG,
  withLogin,
} from "./helpers.js";

/**
 * Leak protection (M6/M31): a secret VALUE — and the AppRole material and the
 * Vault client token that guard it — must never reach an error message, a
 * `toString()`, `JSON.stringify()` or `util.inspect()`. Those four are the
 * surfaces a log line is actually built from.
 */
function assertNoSecret(subject: unknown, label: string): void {
  const rendered = [
    String(subject),
    JSON.stringify(subject) ?? "",
    inspect(subject, { depth: 6, showHidden: false }),
    subject instanceof Error ? `${subject.message}\n${subject.stack ?? ""}` : "",
  ].join("\n");

  for (const secret of SECRET_VALUES) {
    expect(rendered, `${label} leaked ${secret}`).not.toContain(secret);
  }
}

function vaultPort(responses: StubResponse[]) {
  const stub = stubFetch(responses);
  return createVaultSecretPort({
    ...VAULT_CONFIG,
    cacheTtlSeconds: 60,
    deps: { approle: APPROLE, fetchImpl: stub.fetchImpl, clock: fakeClock().clock },
  });
}

describe("no secret material in driver objects", () => {
  it("keeps the client token and AppRole material out of the VaultClient rendering", async () => {
    const stub = stubFetch(withLogin([{ body: fixture("kv-read") }]));
    const client = new VaultClient({
      config: VaultConfig.parse(VAULT_CONFIG),
      approle: APPROLE,
      fetchImpl: stub.fetchImpl,
      clock: fakeClock().clock,
    });

    await client.read("kv/data/jira/pat", "read");

    assertNoSecret(client, "VaultClient");
    expect(Object.keys(client)).not.toContain("token");
  });

  it("keeps cached values out of the VaultSecretPort rendering", async () => {
    const port = vaultPort(withLogin([{ body: fixture("kv-read") }]));

    await port.get("kv/jira/pat#token");

    assertNoSecret(port, "VaultSecretPort");
  });

  it("keeps values out of the env-file driver rendering", async () => {
    const port = createEnvFileSecretPort({
      ...ENV_FILE_CONFIG,
      cacheTtlSeconds: 60,
      deps: { env: { MAESTRO_SECRET_KV_JIRA_PAT__TOKEN: SECRET_VALUES[0] }, nodeEnv: "test" },
    });

    await port.get("kv/jira/pat#token");

    assertNoSecret(port, "EnvFileSecretPort");
  });

  it("keeps values out of the TTL cache rendering", () => {
    const cache = new TtlCache<string>(60, fakeClock().clock);
    cache.set("kv/jira/pat#token", SECRET_VALUES[0]);

    expect(cache.get("kv/jira/pat#token")).toBe(SECRET_VALUES[0]);
    assertNoSecret(cache, "TtlCache");
  });
});

describe("no secret material in errors", () => {
  it("does not echo a response body into a Vault HTTP error", async () => {
    // A misbehaving proxy that returns the secret inside a 500 body.
    const port = vaultPort(withLogin([{ status: 500, body: { errors: [SECRET_VALUES[0]] } }]));

    const error = await port.get("kv/jira/pat#token").catch((e: unknown) => e);

    assertNoSecret(error, "VaultHttpError");
    expect((error as Error).message).toContain("HTTP 500");
  });

  it("does not echo the body into a malformed-response error", async () => {
    const port = vaultPort(withLogin([{ text: `<html>${SECRET_VALUES[1]}</html>` }]));

    assertNoSecret(await port.get("kv/jira/pat#token").catch((e: unknown) => e), "VaultResponseError");
  });

  it("does not carry the credential into an expiry error", async () => {
    const expired = structuredClone(fixture("dynamic-creds")) as Record<string, unknown>;
    expired["lease_duration"] = 0;
    const port = vaultPort(withLogin([{ body: expired }]));

    assertNoSecret(
      await port.issueShortLived("repo/ugurpay-core/push", 600).catch((e: unknown) => e),
      "SecretExpiredError",
    );
  });

  it("does not carry the AppRole secret_id into a login failure", async () => {
    const port = vaultPort([{ status: 403, body: fixture("error-permission-denied") }]);

    assertNoSecret(await port.get("kv/jira/pat#token").catch((e: unknown) => e), "login failure");
  });

  it("names only the key in a not-found error", async () => {
    const port = vaultPort(withLogin([{ status: 404, body: fixture("kv-deleted") }]));

    const error = await port.get("kv/jira/pat#token").catch((e: unknown) => e);

    expect((error as Error).message).toContain("kv/jira/pat#token");
    assertNoSecret(error, "SecretNotFoundError");
  });
});

describe("the value itself is still returned", () => {
  it("does not over-redact — get() hands back the real secret", async () => {
    const port = vaultPort(withLogin([{ body: fixture("kv-read") }]));

    await expect(port.get("kv/jira/pat#token")).resolves.toBe(SECRET_VALUES[1]);
  });
});
