/** Secret port (M80): vault + env-file drivers; cyberark/keyvault later. */
export interface SecretPort {
  get(key: string): Promise<string>;
  /**
   * Write a secret under `key`, encrypting at rest (M80/connector UI). Added so
   * the connector-management surface can STORE an admin-entered token rather
   * than only reading a deployment-provisioned one: the token is enciphered on
   * the way in, and only a reference to it is kept anywhere a console can read.
   *
   * A driver that owns no writable store (a read-only Vault mount, an env-file)
   * throws rather than silently dropping the write — a connector that believed
   * it saved a credential and did not is worse than one that could not save.
   */
  set(key: string, value: string): Promise<void>;
  /** Short-lived scoped credential (e.g. repo push token — M31). */
  issueShortLived(scope: string, ttlSeconds: number): Promise<{ secret: string; expiresAt: string }>;
}
