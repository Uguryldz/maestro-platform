import type { UserDirectory, UserRecord } from "@maestro/bff";

/**
 * The Postgres-backed `UserDirectory` (M8).
 *
 * `apps/bff` ships `InMemoryUserDirectory` as the reference implementation and
 * says in so many words that the production one is Prisma-backed behind the
 * same interface. This is that one — and it lives here rather than in the BFF
 * because the BFF must not import Prisma: every one of its tests runs offline
 * against the same interface.
 *
 * The delegate is structural on purpose. Taking `PrismaClient["user"]` by
 * shape rather than by import keeps this file testable with a plain object and
 * keeps `@maestro/db`'s generated client out of the type surface, which is
 * what lets the whole package typecheck before `prisma generate` has run.
 */

/**
 * The `User` row as READ back. `groupsJson` is a JSON column, so what comes
 * out is genuinely unknown — `parseGroups` is what narrows it.
 */
export interface UserRow {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  groupsJson: unknown;
  active: boolean;
  /**
   * First-run bootstrap flag (migration 0009). Optional on the READ shape so a
   * fake row in a test — and a real row from a database migrated but not yet
   * re-read through a regenerated client — reads as `false` rather than
   * crashing: a missing flag is a non-bootstrap account, the safe default.
   */
  mustChangePassword?: boolean;
}

/**
 * The same row as WRITTEN. Prisma's generated input types reject `unknown` for
 * a JSON column — reasonably, since it is the one place a caller could smuggle
 * a non-serialisable value in — so the write shape names `string[]`, which is
 * all this store ever stores there.
 */
export interface UserWriteRow {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  groupsJson: string[];
  active: boolean;
  /** First-run bootstrap flag (migration 0009). Written on every upsert. */
  mustChangePassword: boolean;
}

/**
 * The three `PrismaClient.user` methods this store uses, and nothing more.
 *
 * The delegate is structural rather than `PrismaClient["user"]`: Prisma's
 * generated delegate is generic over its own argument types, which would drag
 * the whole generated surface into this file and make it uncompilable before
 * `prisma generate` has run. Narrowing to three methods also documents exactly
 * how much of the table this store may touch.
 */
export interface UserDelegate {
  findUnique(args: { where: { email: string } }): Promise<UserRow | null>;
  findMany(args: { take: number; orderBy: { email: "asc" } }): Promise<UserRow[]>;
  upsert(args: {
    where: { email: string };
    create: UserWriteRow;
    update: Omit<UserWriteRow, "id" | "email">;
  }): Promise<unknown>;
  update(args: { where: { email: string }; data: { active: boolean } }): Promise<unknown>;
}

/**
 * Directory groups mapped to platform roles.
 *
 * The `User` model has a `groupsJson` column and no roles column: group
 * membership is what the bank's directory actually owns, and a role is this
 * platform's reading of it. Doing that reading in ONE place is the point —
 * `tech-lead`, `tech-leads`, `tl` and `yonetici` were all in the tree at once
 * before the role set was closed, and each spelling was a different answer to
 * "may this person approve".
 *
 * The values are exactly `@maestro/contracts`'s `Role` union. They are written
 * as literals rather than imported so this file keeps compiling before that
 * module lands; `users.test.ts` asserts each one against `ROLES`, so a value
 * that is not a real role fails the suite rather than the deployment.
 */
export const ROLE_BY_GROUP: Readonly<Record<string, string>> = {
  "maestro-admins": "admin",
  "tech-leads": "tech-lead",
  "product-owners": "product-owner",
  qa: "qa",
  developers: "developer",
  "internal-audit": "viewer",
  // Additional teams mapped onto the SAME six roles (the Role enum is frozen).
  // A group name is free; the AUTHORITY it grants is one of the fixed roles, so
  // adding a team never invents a new privilege.
  operators: "tech-lead", // platform operators (M87) — TL authority, not admin
  analysts: "product-owner", // analyst managers who approve analysis (the flow's Analist Yönetici)
};

/**
 * A user's roles, from their groups.
 *
 * An unrecognised group contributes NOTHING — it does not become a role of its
 * own name. That is what keeps the role set closed: a directory group added
 * next quarter cannot silently become an authorisation the platform honours.
 *
 * `viewer` is the floor rather than a role nobody has: everyone who can log in
 * can read, and the routes that matter check for more than that.
 */
export function rolesOf(groups: readonly string[]): string[] {
  const roles = new Set<string>(["viewer"]);
  for (const group of groups) {
    const role = ROLE_BY_GROUP[group];
    if (role !== undefined) roles.add(role);
  }
  return [...roles];
}

export class PrismaUserDirectory implements UserDirectory {
  constructor(private readonly users: UserDelegate) {}

  async find(username: string): Promise<UserRecord | null> {
    const row = await this.users.findUnique({ where: { email: normalize(username) } });
    return row === null ? null : toRecord(row);
  }

  /**
   * The admin users table (M8/M86). Ordered by email so the same window comes
   * back the same way every time, and bounded by `take` so the query cannot
   * return the whole directory. Inactive rows are kept: off-boarding is a state
   * an admin audits, not a row the list hides.
   */
  async list(limit: number): Promise<readonly UserRecord[]> {
    const rows = await this.users.findMany({ take: Math.max(0, limit), orderBy: { email: "asc" } });
    return rows.map(toRecord);
  }

  async upsert(record: UserRecord): Promise<void> {
    const email = normalize(record.username);
    const groups = [...record.groups];
    // A record with no `displayName` is named by its username — that is what
    // every hand-created account wants, and it is what this store did
    // unconditionally before the field existed. The connector-provisioned bot is
    // the case that needed the other half: its username is a machine id
    // (`jira-bot-maestro`) and its readable name comes from Jira's `/myself`, so
    // writing the username here would have overwritten "maestro (Jira bot)" with
    // the slug on the very next upsert of that row.
    const displayName = record.displayName ?? record.username;
    await this.users.upsert({
      where: { email },
      create: {
        id: record.userId,
        email,
        displayName,
        passwordHash: record.passwordHash,
        groupsJson: groups,
        active: record.active,
        mustChangePassword: record.mustChangePassword ?? false,
      },
      update: {
        displayName,
        passwordHash: record.passwordHash,
        groupsJson: groups,
        active: record.active,
        mustChangePassword: record.mustChangePassword ?? false,
      },
    });
  }

  /**
   * Off-boarding deactivates rather than deletes.
   *
   * A departed approver's row is evidence: their name is on closed gates, and
   * `UserDirectory.find` is what resolves it. Deleting the row would leave the
   * audit trail pointing at nobody, so the account is made unusable instead —
   * which `LocalIdentityProvider` treats exactly like a missing one (M8/M33).
   */
  async remove(username: string): Promise<void> {
    await this.users.update({ where: { email: normalize(username) }, data: { active: false } });
  }
}

function toRecord(row: UserRow): UserRecord {
  const groups = parseGroups(row.groupsJson);
  return {
    username: row.email,
    userId: row.id,
    passwordHash: row.passwordHash,
    groups,
    roles: rolesOf(groups),
    active: row.active,
    // Read back so a re-upsert of an unmodified record keeps the stored name.
    // Without this the round-trip `find` → edit → `upsert` would drop the name
    // to the username, which is exactly the clobber the write side guards
    // against — a read that forgets the field re-opens the hole from the side.
    displayName: row.displayName,
    // A missing flag is a non-bootstrap account — the safe default (M8).
    mustChangePassword: row.mustChangePassword ?? false,
  };
}

/**
 * `groupsJson` is a JSON column, so its contents are whatever was written.
 * Anything that is not an array of strings reads as "no groups": a malformed
 * value must not become a membership, because membership is what opens gates.
 */
function parseGroups(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function normalize(username: string): string {
  return username.trim().toLowerCase();
}
