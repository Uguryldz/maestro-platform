import type { Connection, ConnectionInput } from "@maestro/contracts";

/**
 * The managed-connector store seam (connector-management surface).
 *
 * The editable counterpart to `SettingsReader`, which reports read-only
 * deployment facts. A `ConnectionStore` row is something an admin created from
 * Studio: a URL, an auth kind, non-secret config and a REFERENCE to an
 * AES-encrypted token in the secret store. The store never sees a raw token —
 * that is enciphered through a `SecretPort` before it ever reaches here, and
 * only `secretRef`/`secretMask` are persisted alongside the connection.
 *
 * Structural, like every other store the composition root supplies (M44): no
 * file under `src/routes` imports Prisma, and every test drives an in-memory
 * fake.
 */

/**
 * One connection as WRITTEN — the non-secret fields plus the reference and mask
 * the encryption side produced. `token` is deliberately NOT here: it has been
 * enciphered before this shape is built, and a store that could take a raw
 * token would be a store that could log one.
 */
export interface ConnectionRecord {
  id: string;
  kind: Connection["kind"];
  displayName: string;
  baseUrl: string;
  authKind: Connection["authKind"];
  config: Record<string, string>;
  /** Reference into the secret store; null until a token is set. Never the token. */
  secretRef: string | null;
  /** Last four chars of the stored token, or null. The only glimpse a read gets. */
  secretMask: string | null;
  enabled: boolean;
  /**
   * M18: whether this endpoint runs INSIDE the institution. Only a model
   * connection uses it, and the confidential class leans on it and nothing else
   * — never on a guess made from the URL.
   */
  onPrem: boolean;
  /** Which model answers when a run names none; at most one row may hold it. */
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  /**
   * A short, SECRET-FREE note from the last test — the catalog message key of
   * its outcome. Null until the first test. Never a token/DSN/raw driver text.
   */
  lastTestNote: string | null;
}

/** The last live test's honest verdict, recorded back onto the connection. */
export interface ConnectionTestResult {
  at: string;
  ok: boolean;
  /**
   * The outcome's catalog message key (secret-free), stored so the panel can
   * show WHY a test failed. Optional: a caller that has no key records none.
   */
  note?: string | null;
}

export interface ConnectionStore {
  /** Every connection, for the connector table. Ordered by id for a stable screen. */
  list(): Promise<readonly ConnectionRecord[]>;
  /** One connection, or null when it does not exist. */
  get(id: string): Promise<ConnectionRecord | null>;
  /**
   * Create or replace a connection's non-secret fields plus its secret
   * reference/mask. The caller has already enciphered any new token and passes
   * the resulting `secretRef`/`secretMask`; a `null` secretRef means "no token
   * set". Preserves `lastTestedAt`/`lastTestOk` — an edit to the URL does not
   * un-test the connection, though the caller may choose to clear it.
   */
  put(record: ConnectionRecord): Promise<void>;
  /** Record the outcome of a live test onto an existing connection. */
  recordTest(id: string, result: ConnectionTestResult): Promise<void>;
  /** Remove a connection. Returns its `secretRef` so the caller can drop the secret too. */
  remove(id: string): Promise<{ secretRef: string | null } | null>;
}

/**
 * The `ConnectionInput` a route validated, ready for the service to turn into a
 * `ConnectionRecord`. Re-exported so route and service share one name.
 */
export type ConnectionWrite = ConnectionInput;
