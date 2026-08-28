import { IsoDateTime } from "@maestro/contracts";
import { SecretPermissionDeniedError } from "./errors.js";
import { parseSecretKey, type SecretKey } from "./keys.js";

/**
 * The one place a key becomes usable. Every driver calls it, which is what
 * makes `get()` behave identically across drivers (driver-invariance test):
 * malformed key → SecretKeyError, mount outside the allow-list →
 * SecretPermissionDeniedError, and only then any I/O happens.
 */
export function resolveKey(key: string, allowedMounts: readonly string[], driver: string): SecretKey {
  const parsed = parseSecretKey(key);
  if (!allowedMounts.includes(parsed.mount)) {
    throw new SecretPermissionDeniedError(key, driver, "mount_not_allowed");
  }
  return parsed;
}

/** Epoch millis → the contract's ISO-8601-with-offset form (UTC `Z`). */
export function toIsoDateTime(epochMs: number): IsoDateTime {
  return IsoDateTime.parse(new Date(epochMs).toISOString());
}
