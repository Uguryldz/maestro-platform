/**
 * The narrow seam between this driver's LOGIC and an actual LDAP socket.
 *
 * Everything security-relevant — escaping, the empty-password refusal, the
 * disabled-account check, group→role mapping, fail-closed behaviour — lives
 * above this interface and is therefore testable against a fake directory with
 * no network, no container and no timing flake (the gate's rule).
 *
 * The interface is deliberately smaller than any LDAP library's surface. A
 * driver that could issue arbitrary operations would be a driver whose blast
 * radius nobody can bound by reading it; this one can search, and it can try a
 * bind and be told yes or no.
 */

export interface LdapEntry {
  /** The entry's distinguished name — what the user bind is attempted against. */
  readonly dn: string;
  /**
   * Attributes, lower-cased keys, always arrays. LDAP is multi-valued by
   * nature and collapsing to a scalar at the edge loses group memberships;
   * callers pick the first value where a scalar is meant.
   */
  readonly attributes: Readonly<Record<string, readonly string[]>>;
}

export interface SearchRequest {
  readonly baseDn: string;
  /** Already escaped and rendered — see `filter.ts`. Never built from raw input here. */
  readonly filter: string;
  readonly attributes: readonly string[];
  readonly scope?: "sub" | "one" | "base";
  /**
   * Refuse to page through an unbounded result set. A filter that accidentally
   * matches the whole directory should fail loudly rather than pull 40,000
   * entries into the login path.
   */
  readonly sizeLimit?: number;
}

/**
 * One connection's worth of capability.
 *
 * `bindAs` returns a boolean rather than throwing on bad credentials: at this
 * layer "the password was wrong" is an ANSWER, not an exception. It still
 * throws for transport and protocol failures, which is what keeps "the
 * directory is down" from being mistaken for "the password was wrong" —
 * exactly the confusion that would turn an outage into an open door.
 */
export interface LdapConnection {
  bindAs(dn: string, password: string): Promise<boolean>;
  search(request: SearchRequest): Promise<readonly LdapEntry[]>;
  unbind(): Promise<void>;
}

/**
 * Opens connections. The driver takes this rather than a URL so a test can
 * supply a fake directory, and so the real implementation's TLS options are
 * assembled in exactly one place (`ldapts-client.ts`).
 */
export interface LdapConnectionFactory {
  connect(): Promise<LdapConnection>;
}
