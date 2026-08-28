import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { SecretPort } from "@maestro/ports";

/**
 * A DB-backed `SecretPort` that enciphers connector tokens with AES-256-GCM.
 *
 * This is the ONLY SecretPort in the platform whose `set` actually writes — the
 * Vault and env-file drivers read deployment-provisioned secrets and refuse a
 * console write (a console must not be able to rewrite the mount an operator
 * manages in Vault). A token an admin types into the connector screen is
 * enciphered here and stored as `iv + ciphertext + authTag`; `get` decrypts it,
 * verifying the GCM tag so a tampered row THROWS rather than decrypting to
 * garbage.
 *
 * What is NOT stored: the master key, and the plaintext. The key comes from the
 * environment (`CONNECTOR_MASTER_KEY`), so a database dump alone cannot recover
 * a token. Nothing here logs a plaintext or a key.
 *
 * The delegate is structural, like every other store in this directory: the app
 * must not depend on the generated Prisma client, and this file compiles before
 * `prisma generate` has run.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM's standard 96-bit nonce
const KEY_VERSION = "v1";

/** One `ConnectorSecret` row, as read/written. */
export interface ConnectorSecretRow {
  ref: string;
  iv: string;
  ciphertext: string;
  authTag: string;
  keyVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The `PrismaClient.connectorSecret` methods this store uses. `upsert` makes a
 * re-`set` of the same ref idempotent (a rotation to the same slot), though the
 * connector routes rotate the ref on every new token.
 */
export interface ConnectorSecretDelegate {
  findUnique(args: { where: { ref: string } }): Promise<ConnectorSecretRow | null>;
  upsert(args: {
    where: { ref: string };
    create: ConnectorSecretRow;
    update: Omit<ConnectorSecretRow, "ref" | "createdAt">;
  }): Promise<unknown>;
  delete(args: { where: { ref: string } }): Promise<unknown>;
}

/** An injected clock so a test can assert timestamps without the wall clock. */
export interface Clock {
  now(): Date;
}

const systemClock: Clock = { now: () => new Date() };

export class SecretNotFoundError extends Error {
  constructor(ref: string) {
    // The ref is a slot name, not a secret — safe to name. The VALUE never
    // appears in any error this store throws.
    super(`no secret stored under "${ref}"`);
    this.name = "SecretNotFoundError";
  }
}

export class EncryptedSecretStore implements SecretPort {
  readonly #key: Buffer;
  readonly #delegate: ConnectorSecretDelegate;
  readonly #clock: Clock;

  constructor(key: Buffer, delegate: ConnectorSecretDelegate, clock: Clock = systemClock) {
    if (key.length !== KEY_BYTES) {
      throw new Error(`master key must be ${KEY_BYTES} bytes, got ${key.length}`);
    }
    this.#key = key;
    this.#delegate = delegate;
    this.#clock = clock;
  }

  /**
   * Decrypt the token stored under `ref`.
   *
   * The GCM auth tag is set before `final()`, so a ciphertext or tag that was
   * tampered with — or a wrong key — makes `final()` THROW rather than return
   * altered plaintext. A missing row is a named error, not a silent empty
   * string.
   */
  async get(ref: string): Promise<string> {
    const row = await this.#delegate.findUnique({ where: { ref } });
    if (row === null) throw new SecretNotFoundError(ref);

    const decipher = createDecipheriv(ALGORITHM, this.#key, Buffer.from(row.iv, "base64"));
    decipher.setAuthTag(Buffer.from(row.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(row.ciphertext, "base64")),
      decipher.final(), // throws on a tampered ciphertext / wrong key
    ]);
    return plaintext.toString("utf8");
  }

  /**
   * Encipher and store `value` under `ref`.
   *
   * A FRESH random IV per write — GCM nonce reuse under one key is a
   * confidentiality break, so this never reuses one. The plaintext is held only
   * as a local buffer for the length of the cipher call and is never logged.
   */
  async set(ref: string, value: string): Promise<void> {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const now = this.#clock.now();
    await this.#delegate.upsert({
      where: { ref },
      create: {
        ref,
        iv: iv.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
        authTag: authTag.toString("base64"),
        keyVersion: KEY_VERSION,
        createdAt: now,
        updatedAt: now,
      },
      update: {
        iv: iv.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
        authTag: authTag.toString("base64"),
        keyVersion: KEY_VERSION,
        updatedAt: now,
      },
    });
  }

  /** Remove a stored secret — called when its connection is deleted. */
  async delete(ref: string): Promise<void> {
    await this.#delegate.delete({ where: { ref } });
  }

  /** Not this store's job: connector tokens are long-lived, not minted per use. */
  issueShortLived(): Promise<{ secret: string; expiresAt: string }> {
    return Promise.reject(new Error("EncryptedSecretStore does not issue short-lived credentials"));
  }
}

/**
 * How the connector master key is resolved (M6/M80).
 *
 * Production: `CONNECTOR_MASTER_KEY` MUST be a base64 32-byte key. If it is
 * missing or the wrong size, boot FAILS — a platform that would silently pick a
 * derived key in production is a platform whose "encrypted" tokens are readable
 * by anyone who knows the derivation.
 *
 * Development: when the variable is absent, a documented, deterministic dev-only
 * key is derived AND a warning is emitted (never silent). The warning is the
 * whole point — a developer must know their tokens are protected by a key
 * everyone with the source can reproduce, so it is never mistaken for real
 * protection.
 */
export const DEV_MASTER_KEY_SEED = "maestro-dev-connector-key-do-not-use-in-prod";

export interface ResolveMasterKeyOptions {
  /** The raw `CONNECTOR_MASTER_KEY` value, or undefined when unset. */
  envValue: string | undefined;
  /** Whether this is a production profile — production refuses to derive. */
  isProduction: boolean;
  /** Where the dev-mode warning goes; injected so a test can capture it. */
  warn?: (message: string) => void;
}

export function resolveMasterKey(options: ResolveMasterKeyOptions): Buffer {
  const { envValue, isProduction, warn = (m) => console.warn(m) } = options;

  if (envValue !== undefined && envValue.length > 0) {
    const key = Buffer.from(envValue, "base64");
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `CONNECTOR_MASTER_KEY must decode to ${KEY_BYTES} bytes (base64), got ${key.length}`,
      );
    }
    return key;
  }

  if (isProduction) {
    throw new Error(
      "CONNECTOR_MASTER_KEY is required in production — refusing to derive a dev key that " +
        "anyone with the source could reproduce (M6/M80)",
    );
  }

  // Dev only, and LOUD about it. A deterministic SHA-256 of a documented seed
  // gives a stable 32-byte key across restarts so dev tokens survive a reload,
  // while the warning makes it impossible to mistake for real protection.
  warn(
    "[maestro] CONNECTOR_MASTER_KEY is not set — deriving a DEV-ONLY connector key. " +
      "Connector tokens are NOT securely encrypted. Set CONNECTOR_MASTER_KEY (base64, 32 bytes) " +
      "before storing any real credential.",
  );
  return deriveDevKey();
}

function deriveDevKey(): Buffer {
  return createHash("sha256").update(DEV_MASTER_KEY_SEED).digest();
}
