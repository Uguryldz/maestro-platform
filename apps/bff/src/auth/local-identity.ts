import type { AuthenticatedUser, IdentityProvider, UserDirectory, UserRecord } from "../deps.js";
import { assertPassword, type PasswordHasher, type PasswordPolicy } from "./password.js";

/**
 * MVP identity: local accounts, bcrypt, policy-checked (M8). The AD/LDAP
 * provider of Aşama 2 implements the same {@link IdentityProvider} — which is
 * why the interface takes a password rather than exposing a hash, and why this
 * is the only file in the app that imports a hashing library at all.
 */
export interface LocalAccount {
  username: string;
  /** Audit actor, `user@corp`. */
  userId: string;
  password: string;
  groups: readonly string[];
  roles: readonly string[];
}

export class LocalIdentityProvider implements IdentityProvider {
  readonly driver = "local";

  constructor(
    private readonly users: UserDirectory,
    private readonly hasher: PasswordHasher,
    private readonly policy?: PasswordPolicy,
  ) {}

  async authenticate(username: string, password: string): Promise<AuthenticatedUser | null> {
    const user = await this.users.find(normalize(username));
    // Off-boarded accounts still burn a hash: an attacker must not learn who
    // left the bank by timing the response (M32 — a departed approver is a
    // live risk, so their account state is worth hiding).
    if (user === null || !user.active) {
      await this.hasher.burn();
      return null;
    }
    if (!(await this.hasher.verify(password, user.passwordHash))) return null;
    return {
      userId: user.userId,
      username: user.username,
      groups: user.groups,
      roles: user.roles,
      // Carried onto the session so the client knows to force a change, and so
      // the guard can restrict the session (migration 0009). The bootstrap
      // `admin` account logs in with `admin123` and this true; every normal
      // account has it false.
      mustChangePassword: user.mustChangePassword ?? false,
    };
  }

  /**
   * Create or re-key a local account. The password policy is enforced HERE
   * rather than at login, because a login check could only ever reject people
   * for a rule that was not in force when their password was set.
   *
   * A provisioned account is never a bootstrap account: `mustChangePassword` is
   * false, because provision ran the full policy and the password it wrote is
   * already a real one. The ONLY way an account becomes `mustChangePassword` is
   * the seed (`seedFirstAdmin`), which writes the hash directly and bypasses
   * this method — the policy exemption for `admin123` lives there and nowhere
   * else.
   */
  async provision(account: LocalAccount): Promise<UserRecord> {
    const username = normalize(account.username);
    assertPassword(account.password, username, this.policy);
    const record: UserRecord = {
      username,
      userId: account.userId,
      passwordHash: await this.hasher.hash(account.password),
      groups: [...account.groups],
      roles: [...account.roles],
      active: true,
      mustChangePassword: false,
    };
    await this.users.upsert(record);
    return record;
  }

  /**
   * Change a local account's password (M8 self-service; the first-run bootstrap
   * uses the same path). Verifies the CURRENT password, runs the FULL policy on
   * the new one — so a bootstrap admin cannot "change" back to `admin123`, which
   * is too short and has no symbol — re-keys, and clears `mustChangePassword`.
   *
   * Returns the re-keyed record; `null` when the account is missing/inactive or
   * the current password is wrong (never says which — same discipline as
   * `authenticate`). Killing the account's OTHER sessions is the caller's job:
   * this file owns credentials, not tokens.
   */
  async changePassword(
    username: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<UserRecord | null> {
    const normalized = normalize(username);
    const user = await this.users.find(normalized);
    if (user === null || !user.active) {
      await this.hasher.burn();
      return null;
    }
    if (!(await this.hasher.verify(currentPassword, user.passwordHash))) return null;

    // The new password faces the full policy, no exemption. This is where a
    // bootstrap admin is forced off `admin123` for good.
    assertPassword(newPassword, normalized, this.policy);

    const rekeyed: UserRecord = {
      ...user,
      passwordHash: await this.hasher.hash(newPassword),
      mustChangePassword: false,
    };
    await this.users.upsert(rekeyed);
    return rekeyed;
  }
}

function normalize(username: string): string {
  return username.trim().toLowerCase();
}

/** Reference directory; the production one is Prisma-backed behind the same interface. */
export class InMemoryUserDirectory implements UserDirectory {
  private readonly users = new Map<string, UserRecord>();

  find(username: string): Promise<UserRecord | null> {
    const record = this.users.get(normalize(username));
    return Promise.resolve(record === undefined ? null : { ...record });
  }

  list(limit: number): Promise<readonly UserRecord[]> {
    // Insertion order is what `Map` iterates; a real store would order by a
    // column, but neither the interface nor the screen promises an order — the
    // limit is the contract, not the sort.
    const all = [...this.users.values()].map((record) => ({ ...record }));
    return Promise.resolve(all.slice(0, Math.max(0, limit)));
  }

  upsert(record: UserRecord): Promise<void> {
    this.users.set(normalize(record.username), { ...record });
    return Promise.resolve();
  }

  /**
   * Off-boarding DEACTIVATES rather than deletes, matching the production
   * `PrismaUserDirectory`: a departed approver's name is on closed gates and the
   * audit trail resolves it through `find`, so the row must survive its
   * revocation. The guard treats an inactive account exactly like a missing one
   * (`authGuard` in auth/guard.ts), so access still ends at the next request.
   * Removing an account that was never there is a no-op, not an error.
   */
  remove(username: string): Promise<void> {
    const key = normalize(username);
    const record = this.users.get(key);
    if (record !== undefined) this.users.set(key, { ...record, active: false });
    return Promise.resolve();
  }
}
