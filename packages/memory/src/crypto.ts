import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { SessionCryptoError } from "./errors.js";

/**
 * Agent SDK session files at rest (M31).
 *
 * The workspace itself lives on an encrypted volume, but the archived copy of
 * a session (M65) travels through StoragePort into a bucket the platform does
 * not own, so it is sealed here as well: AES-256-GCM, one random IV per seal,
 * header *and storage key* authenticated. GCM is authenticated encryption, so
 * a truncated or edited blob fails to open instead of decrypting to plausible
 * garbage that a resumed agent would treat as its own memory.
 *
 * The seal is bound to the archive key it is written under (verifier Y-1).
 * Without that binding the ciphertext is portable: anyone able to write to the
 * bucket could copy ticket A's session onto ticket B's key and have B's agent
 * resume A's context — same content key, same magic, no complaint. The key is
 * carried as additional authenticated data, so it costs no bytes and cannot be
 * forged; it also pins the run id and the archive year, which are part of it.
 *
 * The content key is always injected — this module neither derives, stores nor
 * generates long-lived key material (M80: keys come from SecretPort).
 */
export const SESSION_KEY_BYTES = 32;

/** Format 2 = key-bound seal. Format 1 (unbound) is refused on purpose. */
export const SESSION_FORMAT_VERSION = 2;

const MAGIC = Buffer.from("MSES", "ascii");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + 1;
/** Magic + version + IV + tag. */
export const SEALED_OVERHEAD_BYTES = HEADER_BYTES + IV_BYTES + TAG_BYTES;

/**
 * Injected randomness. Deliberately NOT part of the package's public surface
 * (verifier O-10): a caller that can pin the IV can repeat a GCM nonce, and
 * two ciphertexts under one nonce XOR to their plaintexts. Only this module's
 * own tests reach `sealSessionBytesWith`; wiring gets `sealSessionBytes`,
 * which always uses the OS CSPRNG.
 */
export interface RandomSource {
  bytes(count: number): Uint8Array;
}

const nodeRandom: RandomSource = {
  bytes: (count: number) => new Uint8Array(randomBytes(count)),
};

function assertKey(key: Uint8Array): Buffer {
  if (key.length !== SESSION_KEY_BYTES) {
    throw new SessionCryptoError(`key must be ${SESSION_KEY_BYTES} bytes, got ${key.length}`);
  }
  return Buffer.from(key);
}

function header(): Buffer {
  return Buffer.concat([MAGIC, Buffer.from([SESSION_FORMAT_VERSION])]);
}

/**
 * Additional authenticated data: the header plus the storage key this blob
 * belongs to, length-prefixed so no two different keys can produce the same
 * AAD by concatenation.
 */
function aad(head: Buffer, boundKey: string): Buffer {
  if (boundKey.length === 0) {
    throw new SessionCryptoError("a session blob must be bound to its storage key");
  }
  const key = Buffer.from(boundKey, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(key.length);
  return Buffer.concat([head, length, key]);
}

/**
 * Seal a session file for one storage key.
 * Layout: `MSES` | version | iv(12) | tag(16) | ciphertext.
 */
export function sealSessionBytes(
  key: Uint8Array,
  plaintext: Uint8Array,
  boundKey: string,
): Uint8Array {
  return sealSessionBytesWith(nodeRandom, key, plaintext, boundKey);
}

/** Test seam for `sealSessionBytes`. Never exported from the package index. */
export function sealSessionBytesWith(
  random: RandomSource,
  key: Uint8Array,
  plaintext: Uint8Array,
  boundKey: string,
): Uint8Array {
  const secret = assertKey(key);
  const head = header();
  const authenticated = aad(head, boundKey);
  const iv = Buffer.from(random.bytes(IV_BYTES));
  if (iv.length !== IV_BYTES) {
    throw new SessionCryptoError(`iv must be ${IV_BYTES} bytes, got ${iv.length}`);
  }
  const cipher = createCipheriv("aes-256-gcm", secret, iv);
  cipher.setAAD(authenticated);
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  return new Uint8Array(Buffer.concat([head, iv, cipher.getAuthTag(), body]));
}

/**
 * Open a sealed session file that was written under `boundKey`.
 *
 * Any tampering — including presenting the blob under a different storage key
 * — is an error, never a fallback.
 */
export function openSessionBytes(
  key: Uint8Array,
  sealed: Uint8Array,
  boundKey: string,
): Uint8Array {
  const secret = assertKey(key);
  if (sealed.length < SEALED_OVERHEAD_BYTES) throw new SessionCryptoError("blob is truncated");
  const buffer = Buffer.from(sealed);
  const head = buffer.subarray(0, HEADER_BYTES);
  if (!timingSafeEqual(head.subarray(0, MAGIC.length), MAGIC)) {
    throw new SessionCryptoError("not a maestro session blob");
  }
  const version = head[MAGIC.length];
  if (version !== SESSION_FORMAT_VERSION) {
    throw new SessionCryptoError(`unsupported format version ${version}`);
  }
  const authenticated = aad(head, boundKey);
  const iv = buffer.subarray(HEADER_BYTES, HEADER_BYTES + IV_BYTES);
  const tag = buffer.subarray(HEADER_BYTES + IV_BYTES, SEALED_OVERHEAD_BYTES);
  const body = buffer.subarray(SEALED_OVERHEAD_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", secret, iv);
  decipher.setAAD(authenticated);
  decipher.setAuthTag(tag);
  try {
    return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]));
  } catch {
    // The cause is deliberately not echoed: it is the same for a wrong key, a
    // tampered blob and a blob moved to another key, and none of them may leak
    // anything about the key.
    throw new SessionCryptoError("authentication failed (wrong key, altered blob or moved object)");
  }
}
