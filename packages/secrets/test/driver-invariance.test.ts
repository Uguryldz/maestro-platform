import type { SecretPort } from "@maestro/ports";
import { describe, expect, it } from "vitest";
import {
  createEnvFileSecretPort,
  createVaultSecretPort,
  SecretKeyError,
  SecretNotFoundError,
  SecretPermissionDeniedError,
} from "../src/index.js";
import { APPROLE, ENV_FILE_CONFIG, fakeClock, fixture, type StubResponse, stubFetch, VAULT_CONFIG, withLogin } from "./helpers.js";

/**
 * Driver invariance: `get()` is the contract every driver shares (M80), so the
 * same key must produce the same OBSERVABLE outcome — value, SecretNotFound,
 * SecretPermissionDenied, SecretKeyError — whichever driver is wired. Only the
 * transport differs.
 */
const KEY = "kv/jira/pat#token";
const VALUE = "s.JIRA-PAT-NAMED-FIELD-VALUE";

function vault(responses: StubResponse[]): SecretPort {
  const stub = stubFetch(responses);
  return createVaultSecretPort({
    ...VAULT_CONFIG,
    cacheTtlSeconds: 0,
    deps: { approle: APPROLE, fetchImpl: stub.fetchImpl, clock: fakeClock().clock },
  });
}

function envFile(env: Record<string, string>): SecretPort {
  return createEnvFileSecretPort({ ...ENV_FILE_CONFIG, deps: { env, nodeEnv: "test" } });
}

const scenarios = {
  present: {
    vault: () => vault(withLogin([{ body: fixture("kv-read") }])),
    "env-file": () => envFile({ MAESTRO_SECRET_KV_JIRA_PAT__TOKEN: VALUE }),
  },
  absent: {
    vault: () => vault(withLogin([{ status: 404, body: fixture("kv-deleted") }])),
    "env-file": () => envFile({}),
  },
  denied: {
    vault: () => vault([]),
    "env-file": () => envFile({}),
  },
} as const;

const DRIVERS = ["vault", "env-file"] as const;

describe.each(DRIVERS)("get() invariance — %s driver", (name) => {
  it("returns the stored value when the secret is present", async () => {
    await expect(scenarios.present[name]().get(KEY)).resolves.toBe(VALUE);
  });

  it("throws SecretNotFoundError when the secret is absent", async () => {
    await expect(scenarios.absent[name]().get(KEY)).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it("throws SecretPermissionDeniedError for a mount outside the allow-list", async () => {
    const error = await scenarios.denied[name]()
      .get("root/jira/pat#token")
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SecretPermissionDeniedError);
    expect((error as SecretPermissionDeniedError).reason).toBe("mount_not_allowed");
  });

  // "kv" in the allow-list must not entitle "kvault" or "kv-root": a prefix
  // match would let a typo (or a crafted reference) walk another team's tree.
  it.each(["kvault/jira/pat#token", "kv-root/jira/pat#token", "kv2/jira/pat#token", "KV/jira/pat#token"])(
    "refuses %s — the allow-list is matched whole, not by prefix",
    async (key) => {
      const error = await scenarios.denied[name]()
        .get(key)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(SecretPermissionDeniedError);
      expect((error as SecretPermissionDeniedError).reason).toBe("mount_not_allowed");
    },
  );

  it("throws SecretKeyError for a malformed key, before any I/O", async () => {
    await expect(scenarios.denied[name]().get("kv/../auth/token")).rejects.toBeInstanceOf(SecretKeyError);
  });

  it("names the key it was asked for in every failure", async () => {
    const error = await scenarios.absent[name]()
      .get(KEY)
      .catch((e: unknown) => e);

    expect((error as SecretNotFoundError).key).toBe(KEY);
    expect((error as SecretNotFoundError).driver).toBe(name);
  });
});
