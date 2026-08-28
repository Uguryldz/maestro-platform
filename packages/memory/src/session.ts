import type { StoragePort } from "@maestro/ports";
import { archiveKey, ObjectNotFoundError } from "@maestro/storage";
import { openSessionBytes, sealSessionBytes } from "./crypto.js";
import { MemoryArgumentError } from "./errors.js";

/** Session files are recognised by name inside the M65 archive prefix. */
export const SESSION_FILE_PREFIX = "session-";
export const SESSION_FILE_SUFFIX = ".session.enc";
const SESSION_CONTENT_TYPE = "application/octet-stream";

export function sessionFileName(runId: string): string {
  return `${SESSION_FILE_PREFIX}${runId}${SESSION_FILE_SUFFIX}`;
}

export interface SessionRef {
  readonly ticketKey: string;
  readonly runId: string;
  /** Decides the archive year in the key; pass the clock's `now()`. */
  readonly at: string;
}

/**
 * Storage key of one run's session file. Deliberately the storage package's
 * own `archiveKey` (M65 layout) rather than a second convention: a key minted
 * by one package and read by another is exactly where v1 died.
 */
export function sessionArchiveKey(ref: SessionRef): string {
  return archiveKey({
    ticketKey: ref.ticketKey,
    fileName: sessionFileName(ref.runId),
    createdAt: ref.at,
  });
}

export interface SessionArchiveDeps {
  readonly storage: StoragePort;
  /** 32-byte content key, injected from SecretPort at wiring time (M80). */
  readonly key: Uint8Array;
  /**
   * Ask the driver for a WORM lock on the written object (M5/M57).
   *
   * Off by default because only some buckets support it. Without it a second
   * `put` on the same key silently replaces the archived session — the key is
   * `(year, ticket, run)`, so that only happens when the same run is archived
   * twice, and the newer file is then the right one. With it, the first
   * archive of a run is the one an auditor gets back.
   */
  readonly objectLock?: boolean;
}

export interface SavedSession {
  readonly key: string;
  /** Size of the sealed object, not of the plaintext. */
  readonly bytes: number;
}

/**
 * Archive an Agent SDK session file (M30/M31/M65).
 *
 * The plaintext never reaches the port: sealing happens here, so a
 * misconfigured or third-party bucket receives ciphertext only. The seal is
 * bound to the storage key, so the object cannot be replayed under another
 * ticket's or another run's key.
 */
export async function saveSessionFile(
  deps: SessionArchiveDeps,
  ref: SessionRef,
  contents: Uint8Array,
): Promise<SavedSession> {
  const key = sessionArchiveKey(ref);
  const sealed = sealSessionBytes(deps.key, contents, key);
  await deps.storage.put(key, sealed, {
    contentType: SESSION_CONTENT_TYPE,
    ...(deps.objectLock === true ? { objectLock: true } : {}),
  });
  return { key, bytes: sealed.length };
}

/**
 * Restore a session file. Throws when the object exists but cannot be opened —
 * including when it is a valid session sealed for a *different* key.
 */
export async function loadSessionFile(
  deps: SessionArchiveDeps,
  key: string,
): Promise<Uint8Array> {
  return openSessionBytes(deps.key, await deps.storage.get(key), key);
}

/**
 * Restore a session file if it is still there, otherwise report its absence.
 *
 * Absence is a normal state, not a failure: after a workspace archive the
 * session may have been swept, and the flow then bootstraps from the journal
 * alone (M65). A corrupt or unreadable object is NOT absence — that still
 * throws, because silently starting a fresh session on a damaged one would
 * lose exactly the context this package exists to keep.
 */
export async function tryLoadSessionFile(
  deps: SessionArchiveDeps,
  key: string,
): Promise<Uint8Array | null> {
  let sealed: Uint8Array;
  try {
    sealed = await deps.storage.get(key);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) return null;
    throw error;
  }
  return openSessionBytes(deps.key, sealed, key);
}

async function keysOfYear(
  storage: StoragePort,
  ticketKey: string,
  year: number,
): Promise<string[]> {
  // Minted through archiveKey so the prefix can never drift from the layout.
  const sample = archiveKey({
    ticketKey,
    fileName: "sample",
    createdAt: `${String(year).padStart(4, "0")}-01-01T00:00:00Z`,
  });
  const prefix = sample.slice(0, sample.lastIndexOf("/") + 1);
  const keys = await storage.list(prefix);
  return keys.filter((key) => {
    const name = key.slice(prefix.length);
    return name.startsWith(SESSION_FILE_PREFIX) && name.endsWith(SESSION_FILE_SUFFIX);
  });
}

/**
 * Session-file keys archived for one ticket, sorted.
 *
 * The fallback path for a resume whose stored key was lost. A range is
 * accepted because the archive year comes from the run's last activity while
 * the resume happens whenever it happens: 60 idle days routinely straddle new
 * year, and scanning a single year would report "no session" for a ticket
 * whose session is one directory away (verifier D-12).
 */
export async function listSessionKeys(
  storage: StoragePort,
  ticketKey: string,
  fromYear: number,
  throughYear: number = fromYear,
): Promise<string[]> {
  if (!Number.isInteger(fromYear) || !Number.isInteger(throughYear) || throughYear < fromYear) {
    throw new MemoryArgumentError("listSessionKeys", "years must be integers and ordered");
  }
  const found: string[] = [];
  for (let year = fromYear; year <= throughYear; year += 1) {
    found.push(...(await keysOfYear(storage, ticketKey, year)));
  }
  return found.sort((a, b) => a.localeCompare(b));
}
