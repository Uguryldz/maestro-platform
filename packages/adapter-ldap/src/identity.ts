import type { LdapConnection, LdapConnectionFactory, LdapEntry } from "./client.js";
import { LDAP_IDENTITY_DRIVER, type LdapIdentityConfig } from "./config.js";
import { LdapServiceAccountError, LdapUnavailableError } from "./errors.js";
import { renderUserFilter } from "./filter.js";
import { isDisabledAccount } from "./account-state.js";
import { mapGroupsToRoles } from "./roles.js";

/**
 * The LDAPS bind identity driver (M8: "karar: LDAP bind").
 *
 * We never see, verify or store a password hash. The directory is the authority
 * on whether a password is right, and the only way to ask it is to attempt a
 * bind AS the user. That is the whole design: a hash we do not hold is a hash
 * we cannot leak, and a password policy we do not implement is one that cannot
 * disagree with the bank's.
 *
 * Structurally implements the BFF's `IdentityProvider`. It does not IMPORT that
 * type — `apps/bff` is an application and no package may depend on it (M44). A
 * structural match is what lets the composition root pass this where the local
 * provider goes, with the compiler checking the fit.
 */

export interface LdapAuthenticatedUser {
  readonly userId: string;
  readonly username: string;
  readonly groups: readonly string[];
  readonly roles: readonly string[];
}

export interface LdapIdentityDeps {
  readonly connections: LdapConnectionFactory;
  /** Resolves `bindPasswordRef` through `@maestro/secrets`. Never a literal. */
  readonly servicePassword: () => Promise<string>;
}

export class LdapIdentityProvider {
  readonly driver = LDAP_IDENTITY_DRIVER;

  constructor(
    private readonly config: LdapIdentityConfig,
    private readonly deps: LdapIdentityDeps,
  ) {}

  /**
   * `null` for "no such user" and "wrong password" alike — the interface's
   * contract, and the reason there is exactly one `return null` path shape
   * here. Telling the two apart hands an attacker a username oracle, which is
   * how a password-spray campaign gets its target list.
   */
  async authenticate(username: string, password: string): Promise<LdapAuthenticatedUser | null> {
    /**
     * The anonymous-bind trap, closed before any I/O.
     *
     * RFC 4513 §5.1.2: a bind with a zero-length password is an UNAUTHENTICATED
     * bind, and a conforming directory answers `success` to it. The request
     * "log in as alice with no password" therefore returns success, and a
     * driver that trusted the bind result would authenticate anyone who leaves
     * the field blank. Whitespace is included because it is trimmed to nothing
     * by some servers and not others — the difference is not ours to gamble on.
     */
    if (password.trim().length === 0) return null;
    const login = username.trim();
    if (login.length === 0) return null;

    let connection: LdapConnection | undefined;
    try {
      connection = await this.deps.connections.connect();
      const entry = await this.findUser(connection, login);

      /**
       * No entry: return null WITHOUT skipping the work a real login does.
       * The bind against a non-existent DN below is the timing equaliser — the
       * local provider burns a bcrypt hash for the same reason. Without it,
       * "unknown account" returns in one round trip and "wrong password"
       * returns in two, which a stopwatch reads as an account enumeration API.
       */
      if (entry === null) {
        await this.burn(connection);
        return null;
      }

      /**
       * A disabled account must not be able to bind — but some directories
       * still accept the bind and let the application decide. Checked BEFORE
       * the bind so a deactivated person cannot even prove their password, and
       * the check burns the same round trip so the timing does not disclose
       * that the account exists but is locked.
       */
      if (isDisabledAccount(entry)) {
        await this.burn(connection);
        return null;
      }

      const ok = await connection.bindAs(entry.dn, password);
      if (!ok) return null;

      /**
       * Group membership is read AFTER the user's own bind succeeded, on the
       * SERVICE connection: the user's credentials proved who they are, and the
       * service account is the one with directory read rights. Re-binding as
       * the service account here is what makes that safe — a connection left
       * bound as the user would read groups with the user's own (possibly
       * narrower, possibly wider) rights.
       */
      const groups = await this.readGroups(connection, entry.dn);
      return {
        userId: this.userIdOf(entry, login),
        username: this.usernameOf(entry, login),
        groups,
        roles: mapGroupsToRoles(groups, this.config.roleMappings, this.config.defaultRoles),
      };
    } catch (error) {
      /**
       * Fail-closed (M6). An unreachable directory is NOT a reason to fall back
       * to a local account — a silent fallback is how an attacker who can drop
       * packets downgrades the bank to whatever weaker store sits behind it.
       * The error propagates so the login fails loudly and the operator is
       * paged; it never becomes `null`, which would read as "bad password" and
       * hide an outage behind a support ticket about forgotten passwords.
       */
      if (error instanceof LdapServiceAccountError) throw error;
      throw new LdapUnavailableError(
        `directory query failed for the login path — login refused rather than falling back`,
        error,
      );
    } finally {
      if (connection !== undefined) {
        // Never let a close failure mask the real outcome.
        await connection.unbind().catch(() => undefined);
      }
    }
  }

  /** Bind the service account, then search for the login name. */
  private async findUser(connection: LdapConnection, login: string): Promise<LdapEntry | null> {
    await this.bindService(connection);
    const filter = renderUserFilter(this.config.userFilter, login);
    const entries = await connection.search({
      baseDn: this.config.userBaseDn,
      filter,
      attributes: [
        this.config.usernameAttribute,
        this.config.userIdAttribute,
        "mail",
        "userAccountControl",
        "accountExpires",
        "nsAccountLock",
      ],
      scope: "sub",
      sizeLimit: 2,
    });

    /**
     * Two matches means the filter is ambiguous — refuse rather than pick.
     * "Pick the first" is how an injected or over-broad filter authenticates
     * the wrong person, and it fails silently forever after.
     */
    if (entries.length !== 1) return null;
    return entries[0] ?? null;
  }

  private async bindService(connection: LdapConnection): Promise<void> {
    const password = await this.deps.servicePassword();
    if (password.trim().length === 0) {
      throw new LdapServiceAccountError(
        `resolved an empty password from the configured reference — refusing to attempt an ` +
          `anonymous bind that would appear to succeed`,
      );
    }
    const ok = await connection.bindAs(this.config.bindDn, password);
    if (!ok) {
      /**
       * The message names the DN and the REFERENCE, never the value. An
       * operator needs to know which credential failed; a log aggregator must
       * not learn what it was.
       */
      throw new LdapServiceAccountError(
        `bind failed for ${this.config.bindDn} using ${this.config.bindPasswordRef} — ` +
          `check the credential in the secret store, not in this log`,
      );
    }
  }

  /**
   * Spend the same round trip a real failed login spends.
   *
   * Bound to a DN that cannot exist under the configured base, with a value
   * that is not a usable password. The directory does the same parse and
   * lookup work and answers no, so "unknown account" and "wrong password" cost
   * the same. Failures are swallowed: this call exists for its DURATION.
   */
  private async burn(connection: LdapConnection): Promise<void> {
    await connection
      .bindAs(`cn=maestro-timing-equaliser,${this.config.userBaseDn}`, "maestro-timing-equaliser")
      .catch(() => false);
  }

  private async readGroups(connection: LdapConnection, userDn: string): Promise<readonly string[]> {
    await this.bindService(connection);
    const filter = this.config.groupFilter.split("{{dn}}").join(escapeDnForFilter(userDn));
    const entries = await connection.search({
      baseDn: this.config.groupBaseDn ?? this.config.userBaseDn,
      filter,
      attributes: [this.config.groupNameAttribute],
      scope: "sub",
      sizeLimit: 500,
    });

    const names: string[] = [];
    for (const entry of entries) {
      const value = entry.attributes[this.config.groupNameAttribute.toLowerCase()]?.[0];
      // Both the name and the DN are carried: an operator may map on either.
      if (value !== undefined && value.length > 0) names.push(value);
      else if (entry.dn.length > 0) names.push(entry.dn);
    }
    return names;
  }

  private usernameOf(entry: LdapEntry, login: string): string {
    return entry.attributes[this.config.usernameAttribute.toLowerCase()]?.[0] ?? login;
  }

  /**
   * The audit actor (`user@corp`, M33), never empty: UPN, then mail, then a
   * constructed fallback. An audit row whose actor is blank cannot be used to
   * answer "who approved this", which is the question the trail exists for.
   */
  private userIdOf(entry: LdapEntry, login: string): string {
    const primary = entry.attributes[this.config.userIdAttribute.toLowerCase()]?.[0];
    if (primary !== undefined && primary.length > 0) return primary;
    const mail = entry.attributes["mail"]?.[0];
    if (mail !== undefined && mail.length > 0) return mail;
    const domain = this.config.userIdFallbackDomain;
    return domain === undefined ? login : `${login}@${domain}`;
  }
}

/**
 * A DN spliced into a FILTER is an assertion value and needs filter escaping
 * (RFC 4515), not DN escaping: its commas are data here. It comes from the
 * directory rather than the user, but escaping it anyway costs nothing and
 * removes the need to prove that every directory everywhere returns tame DNs.
 */
function escapeDnForFilter(dn: string): string {
  return dn.replace(/[\\*()\0]/g, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return `\\${code.toString(16).padStart(2, "0")}`;
  });
}
