import type { SessionRecord, SessionStore } from "@maestro/bff";

/**
 * The Postgres-backed `SessionStore` (M8), made durable in Dalga E.
 *
 * `apps/bff` ships `InMemorySessionStore` as the reference implementation and
 * says in so many words that the production one is Redis/Postgres behind the
 * same interface. This is the Postgres one — and it lives here rather than in
 * the BFF for the same reason `PrismaUserDirectory` does: the BFF must not
 * import Prisma, so every one of its tests runs offline against the interface.
 *
 * Why this matters. The in-memory store held live logins in a JavaScript `Map`,
 * and the process runs under `restart: unless-stopped`. A redeploy or a crash
 * therefore signed EVERY logged-in user out at once, mid-task, with nothing to
 * tell them why. That is a support storm rather than a data loss, but it is one
 * that arrives on any restart. A row per token is what makes a session survive.
 *
 * The token-lookup timing note. `InMemorySessionStore.get` scanned its map in
 * constant time so a timing measurement could not be turned into a token
 * oracle. A primary-key lookup here is NOT constant-time — but the token is 256
 * bits from the CSPRNG, so there is nothing to enumerate: an attacker would
 * have to guess the whole token before any timing difference could tell them
 * they were close, and guessing the whole token is the win, not a step toward
 * it. The database is the right store precisely because the token is
 * unguessable, and a per-request table scan to preserve constant time would be
 * a self-inflicted denial of service for no security gain.
 *
 * The delegate is structural, exactly like `PrismaUserDirectory`: taking the
 * `PrismaClient["session"]` shape rather than the import keeps this file
 * testable with a plain object and keeps the generated client out of the type
 * surface, which is what lets the package typecheck before `prisma generate`
 * has run.
 */

/** The `Session` row as READ back. JSON columns arrive as `unknown`. */
export interface SessionRow {
  token: string;
  userId: string;
  username: string;
  rolesJson: unknown;
  groupsJson: unknown;
  delegated: boolean;
  issuedAt: Date;
  expiresAt: Date;
}

/**
 * The same row as WRITTEN. Prisma's generated input types reject `unknown` for
 * a JSON column, so the write shape names `string[]` — all this store ever
 * stores in `rolesJson`/`groupsJson`.
 */
export interface SessionWriteRow {
  token: string;
  userId: string;
  username: string;
  rolesJson: string[];
  groupsJson: string[];
  delegated: boolean;
  issuedAt: Date;
  expiresAt: Date;
}

/**
 * The `PrismaClient.session` methods this store uses, and nothing more.
 *
 * Structural rather than `PrismaClient["session"]` for the reason above; the
 * narrowing also documents exactly how much of the table this store may touch.
 * `create` uses `upsert` semantics via `create`-then-catch? No — a fresh token
 * cannot collide, so a plain `create` is correct and a duplicate token is a
 * CSPRNG failure worth surfacing rather than swallowing.
 */
export interface SessionDelegate {
  create(args: { data: SessionWriteRow }): Promise<unknown>;
  findUnique(args: { where: { token: string } }): Promise<SessionRow | null>;
  delete(args: { where: { token: string } }): Promise<unknown>;
  findMany(args: { where: { userId: string }; orderBy: { issuedAt: "asc" } }): Promise<SessionRow[]>;
  deleteMany(args: { where: { userId: string } }): Promise<{ count: number }>;
}

export class PrismaSessionStore implements SessionStore {
  constructor(private readonly sessions: SessionDelegate) {}

  async create(record: SessionRecord): Promise<void> {
    await this.sessions.create({ data: toWriteRow(record) });
  }

  async get(token: string): Promise<SessionRecord | null> {
    const row = await this.sessions.findUnique({ where: { token } });
    return row === null ? null : toRecord(row);
  }

  /**
   * Deleting a token that is already gone is a no-op, not an error: a logout
   * racing an expiry sweep, or a double-clicked logout button, must not turn
   * into a 500. `delete` throws on a missing row, so the not-found case is
   * caught and swallowed — every other failure propagates.
   */
  async delete(token: string): Promise<void> {
    try {
      await this.sessions.delete({ where: { token } });
    } catch (error) {
      if (!isRecordNotFound(error)) throw error;
    }
  }

  /**
   * Every session this user holds, oldest first — the order the eviction cap
   * (`MAX_SESSIONS_PER_USER`) depends on, so the oldest is the first match.
   * `InMemorySessionStore` got this from insertion order; here it is an explicit
   * `ORDER BY issuedAt`, because a table has no insertion order to lean on.
   */
  async listByUser(userId: string): Promise<readonly SessionRecord[]> {
    const rows = await this.sessions.findMany({ where: { userId }, orderBy: { issuedAt: "asc" } });
    return rows.map(toRecord);
  }

  /** Drop all of this user's sessions; returns how many were live (M8/M32). */
  async deleteByUser(userId: string): Promise<number> {
    const { count } = await this.sessions.deleteMany({ where: { userId } });
    return count;
  }
}

function toWriteRow(record: SessionRecord): SessionWriteRow {
  return {
    token: record.token,
    userId: record.userId,
    username: record.username,
    rolesJson: [...record.roles],
    groupsJson: [...record.groups],
    delegated: record.delegated,
    issuedAt: new Date(record.issuedAt),
    expiresAt: new Date(record.expiresAt),
  };
}

function toRecord(row: SessionRow): SessionRecord {
  return {
    token: row.token,
    userId: row.userId,
    username: row.username,
    roles: parseStringArray(row.rolesJson),
    groups: parseStringArray(row.groupsJson),
    delegated: row.delegated,
    issuedAt: row.issuedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

/**
 * A JSON array column reads back as `unknown`. Anything that is not an array of
 * strings reads as empty: a malformed value must not become a role or a group,
 * because both are what the guard checks. A session with no roles falls to the
 * floor role the same way a fresh login with no groups would.
 */
function parseStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Prisma raises `P2025` ("record to delete does not exist") for a `delete` with
 * no matching row. Matched by the `code` property structurally so this file
 * needs neither the generated `Prisma.PrismaClientKnownRequestError` class nor
 * an import of it — the same discipline the rest of `stores/` follows.
 */
function isRecordNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2025"
  );
}
