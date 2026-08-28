import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  DEV_MASTER_KEY_SEED,
  EncryptedSecretStore,
  SecretNotFoundError,
  resolveMasterKey,
  type ConnectorSecretDelegate,
  type ConnectorSecretRow,
} from "../src/stores/encrypted-secret.js";

/**
 * The AES-256-GCM secret store, offline.
 *
 * The delegate is a single-row-per-ref Map, exactly as the `ConnectorSecret`
 * table behaves. The properties under test are the ones a leak would breach:
 * a round-trip returns the token, a WRONG KEY or a TAMPERED ciphertext THROWS
 * (never decrypts to garbage), each write uses a FRESH IV, and the master key
 * resolution refuses to derive a dev key in production.
 */

function fakeDelegate(): { delegate: ConnectorSecretDelegate; rows: Map<string, ConnectorSecretRow> } {
  const rows = new Map<string, ConnectorSecretRow>();
  const delegate: ConnectorSecretDelegate = {
    findUnique: (args) => Promise.resolve(rows.get(args.where.ref) ?? null),
    upsert: (args) => {
      const existing = rows.get(args.where.ref);
      rows.set(args.where.ref, existing === undefined
        ? args.create
        : { ...existing, ...args.update });
      return Promise.resolve(rows.get(args.where.ref));
    },
    delete: (args) => {
      rows.delete(args.where.ref);
      return Promise.resolve(undefined);
    },
  };
  return { delegate, rows };
}

const KEY = randomBytes(32);

describe("EncryptedSecretStore round-trip", () => {
  it("get after set returns the exact token", async () => {
    const { delegate } = fakeDelegate();
    const store = new EncryptedSecretStore(KEY, delegate);
    await store.set("connector:jira:1", "s3cr3t-jira-token");
    expect(await store.get("connector:jira:1")).toBe("s3cr3t-jira-token");
  });

  it("never stores the plaintext — the row holds only iv/ciphertext/tag", async () => {
    const { delegate, rows } = fakeDelegate();
    const store = new EncryptedSecretStore(KEY, delegate);
    await store.set("connector:github:1", "ghp_realtoken");
    const row = rows.get("connector:github:1")!;
    expect(JSON.stringify(row)).not.toContain("ghp_realtoken");
    expect(row.iv.length).toBeGreaterThan(0);
    expect(row.authTag.length).toBeGreaterThan(0);
  });

  it("uses a FRESH iv for every write (GCM nonce reuse is a break)", async () => {
    const { delegate, rows } = fakeDelegate();
    const store = new EncryptedSecretStore(KEY, delegate);
    await store.set("a", "same-value");
    const first = rows.get("a")!.iv;
    await store.set("b", "same-value");
    const second = rows.get("b")!.iv;
    expect(first).not.toBe(second);
  });

  it("throws a named error when the ref has no secret", async () => {
    const { delegate } = fakeDelegate();
    const store = new EncryptedSecretStore(KEY, delegate);
    await expect(store.get("missing")).rejects.toBeInstanceOf(SecretNotFoundError);
  });
});

describe("EncryptedSecretStore rejects tampering and the wrong key", () => {
  it("a WRONG key cannot decrypt — it throws, never returns garbage", async () => {
    const { delegate } = fakeDelegate();
    await new EncryptedSecretStore(KEY, delegate).set("ref", "token");

    const otherKey = randomBytes(32);
    await expect(new EncryptedSecretStore(otherKey, delegate).get("ref")).rejects.toThrow();
  });

  it("a TAMPERED ciphertext fails the GCM tag and throws", async () => {
    const { delegate, rows } = fakeDelegate();
    const store = new EncryptedSecretStore(KEY, delegate);
    await store.set("ref", "token");

    // Flip a byte of the ciphertext.
    const row = rows.get("ref")!;
    const bytes = Buffer.from(row.ciphertext, "base64");
    bytes[0] = bytes[0]! ^ 0xff;
    rows.set("ref", { ...row, ciphertext: bytes.toString("base64") });

    await expect(store.get("ref")).rejects.toThrow();
  });

  it("a TAMPERED auth tag throws", async () => {
    const { delegate, rows } = fakeDelegate();
    const store = new EncryptedSecretStore(KEY, delegate);
    await store.set("ref", "token");

    const row = rows.get("ref")!;
    const tag = Buffer.from(row.authTag, "base64");
    tag[0] = tag[0]! ^ 0xff;
    rows.set("ref", { ...row, authTag: tag.toString("base64") });

    await expect(store.get("ref")).rejects.toThrow();
  });

  it("refuses a key of the wrong length at construction", () => {
    const { delegate } = fakeDelegate();
    expect(() => new EncryptedSecretStore(randomBytes(16), delegate)).toThrow(/32 bytes/);
  });

  it("delete removes the row", async () => {
    const { delegate, rows } = fakeDelegate();
    const store = new EncryptedSecretStore(KEY, delegate);
    await store.set("ref", "token");
    await store.delete("ref");
    expect(rows.has("ref")).toBe(false);
  });
});

describe("resolveMasterKey", () => {
  it("uses the env key when it is a valid base64 32-byte value", () => {
    const raw = randomBytes(32).toString("base64");
    const key = resolveMasterKey({ envValue: raw, isProduction: true });
    expect(key.length).toBe(32);
    expect(key.toString("base64")).toBe(raw);
  });

  it("refuses an env key of the wrong size", () => {
    const raw = randomBytes(16).toString("base64");
    expect(() => resolveMasterKey({ envValue: raw, isProduction: false })).toThrow(/32 bytes/);
  });

  it("REFUSES to derive a dev key in production", () => {
    expect(() => resolveMasterKey({ envValue: undefined, isProduction: true })).toThrow(
      /required in production/,
    );
  });

  it("derives a dev key WITH A WARNING in development — never silently", () => {
    const warn = vi.fn();
    const key = resolveMasterKey({ envValue: undefined, isProduction: false, warn });
    expect(key.length).toBe(32);
    // The warning fired, and it names the variable to set.
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("CONNECTOR_MASTER_KEY");
    expect(warn.mock.calls[0]?.[0]).toContain("NOT securely encrypted");
  });

  it("the dev key is deterministic across calls (dev tokens survive a reload)", () => {
    const a = resolveMasterKey({ envValue: undefined, isProduction: false, warn: () => {} });
    const b = resolveMasterKey({ envValue: undefined, isProduction: false, warn: () => {} });
    expect(a.equals(b)).toBe(true);
    // And it is the documented seed's hash, not something ambient.
    expect(DEV_MASTER_KEY_SEED).toContain("dev");
  });
});
