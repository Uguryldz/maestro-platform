import type { LdapEntry } from "./client.js";

/**
 * Is this directory entry a deactivated account?
 *
 * The audit finding this closes: "iptal edilen hesap 8 saat admin kaldı" — a
 * cancelled account kept admin authority for eight hours, the length of a
 * session. Sessions are absolute and do not slide (M8), so the account state
 * must be checked at LOGIN; anything that gets past this line owns its
 * authority until the token expires.
 *
 * Three independent signals, because the bank's directory may be AD today and
 * something else after a merger, and a check that only understands one schema
 * silently passes every account in the other.
 */

/** `userAccountControl` bit 2 (0x0002) — ACCOUNTDISABLE in Active Directory. */
const ACCOUNTDISABLE = 0x0002;

/**
 * `accountExpires` is a Windows FILETIME: 100-nanosecond ticks since 1601-01-01.
 * Zero and 0x7FFFFFFFFFFFFFFF both mean "never expires" — the two values AD
 * uses interchangeably, and treating either as a date puts expiry in 1601 and
 * locks out the entire directory.
 */
const FILETIME_NEVER = new Set(["0", "9223372036854775807"]);
const FILETIME_EPOCH_OFFSET_MS = 11_644_473_600_000n;

export function isDisabledAccount(entry: LdapEntry, now: Date = new Date()): boolean {
  return (
    hasDisabledBit(entry) || isExpired(entry, now) || isLockedByNsAccountLock(entry)
  );
}

function hasDisabledBit(entry: LdapEntry): boolean {
  const raw = entry.attributes["useraccountcontrol"]?.[0];
  if (raw === undefined) return false;
  const value = Number.parseInt(raw, 10);
  /**
   * An unparseable value is treated as DISABLED, not as enabled. Fail-closed:
   * the cost of refusing a valid login is a support call, the cost of admitting
   * a cancelled one is the finding this file exists to close.
   */
  if (!Number.isFinite(value)) return true;
  return (value & ACCOUNTDISABLE) !== 0;
}

function isExpired(entry: LdapEntry, now: Date): boolean {
  const raw = entry.attributes["accountexpires"]?.[0];
  if (raw === undefined || FILETIME_NEVER.has(raw)) return false;
  let ticks: bigint;
  try {
    ticks = BigInt(raw);
  } catch {
    return true; // unparseable → fail closed
  }
  if (ticks <= 0n) return false;
  const epochMs = ticks / 10_000n - FILETIME_EPOCH_OFFSET_MS;
  return epochMs <= BigInt(now.getTime());
}

/** 389-DS / OpenLDAP convention: `nsAccountLock: true` disables the account. */
function isLockedByNsAccountLock(entry: LdapEntry): boolean {
  const raw = entry.attributes["nsaccountlock"]?.[0];
  return raw !== undefined && raw.trim().toLowerCase() === "true";
}
