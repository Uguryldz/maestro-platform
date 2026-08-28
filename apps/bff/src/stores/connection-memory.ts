import type {
  ConnectionRecord,
  ConnectionStore,
  ConnectionTestResult,
} from "../connection-store.js";

/**
 * An in-memory `ConnectionStore` for tests and a store-less deployment.
 *
 * Holds records in a Map keyed by id, ordered on read so a screen renders a
 * stable list. It stores exactly what the real Prisma store stores — the
 * non-secret fields plus `secretRef`/`secretMask` — and never a raw token,
 * which is the property the connector tests assert on: what lands in this store
 * is what a database dump would hold, and a token is not in it.
 */
export class InMemoryConnectionStore implements ConnectionStore {
  private readonly rows = new Map<string, ConnectionRecord>();

  constructor(initial: readonly ConnectionRecord[] = []) {
    for (const row of initial) this.rows.set(row.id, { ...row, config: { ...row.config } });
  }

  list(): Promise<readonly ConnectionRecord[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((row) => ({ ...row, config: { ...row.config } })),
    );
  }

  get(id: string): Promise<ConnectionRecord | null> {
    const row = this.rows.get(id);
    return Promise.resolve(row === undefined ? null : { ...row, config: { ...row.config } });
  }

  put(record: ConnectionRecord): Promise<void> {
    this.rows.set(record.id, { ...record, config: { ...record.config } });
    return Promise.resolve();
  }

  recordTest(id: string, result: ConnectionTestResult): Promise<void> {
    const row = this.rows.get(id);
    if (row !== undefined) {
      this.rows.set(id, {
        ...row,
        lastTestedAt: result.at,
        lastTestOk: result.ok,
        lastTestNote: result.note ?? null,
      });
    }
    return Promise.resolve();
  }

  remove(id: string): Promise<{ secretRef: string | null } | null> {
    const row = this.rows.get(id);
    if (row === undefined) return Promise.resolve(null);
    this.rows.delete(id);
    return Promise.resolve({ secretRef: row.secretRef });
  }
}

/**
 * An in-memory `SecretPort` for tests: an AES store's behaviour without the
 * crypto, so a route test can exercise set/get/delete without a key. It still
 * honours the ONE property the routes depend on — `get` after `set` returns the
 * token, and nothing else can read it — while a route test asserts the token is
 * absent from every RESPONSE, which this store does not affect.
 *
 * The real encryption round-trip (and tamper/wrong-key rejection) is tested
 * against `EncryptedSecretStore` in apps/deploy, where the crypto lives.
 */
export class InMemorySecretStore {
  private readonly secrets = new Map<string, string>();

  get(key: string): Promise<string> {
    const value = this.secrets.get(key);
    if (value === undefined) return Promise.reject(new Error("no such secret"));
    return Promise.resolve(value);
  }

  set(key: string, value: string): Promise<void> {
    this.secrets.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.secrets.delete(key);
    return Promise.resolve();
  }

  issueShortLived(): Promise<{ secret: string; expiresAt: string }> {
    return Promise.reject(new Error("not used by the connector store"));
  }

  /** Test-only: assert what was actually stored (to prove it is not the raw... nothing here is). */
  has(key: string): boolean {
    return this.secrets.has(key);
  }
}
