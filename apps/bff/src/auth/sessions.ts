import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AuthenticatedUser, Clock, SessionRecord, SessionStore } from "../deps.js";

/** Eight hours (M8). */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * How many sessions one account may hold at once. A person works from a
 * desktop and maybe a laptop; a hundred live tokens for one login is a stolen
 * credential being replayed, not a way of working. When the cap is reached the
 * OLDEST session is evicted, so the cap can never lock a real user out of their
 * own account by filling their quota with stale tokens.
 */
export const MAX_SESSIONS_PER_USER = 5;

/** 256 bits from the CSPRNG; the token is the whole credential. */
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function issueSession(
  user: AuthenticatedUser,
  options: { clock: Clock; ttlMs?: number; delegated?: boolean; token?: string },
): SessionRecord {
  const issuedAt = options.clock.now();
  const ttl = options.ttlMs ?? SESSION_TTL_MS;
  return {
    token: options.token ?? newSessionToken(),
    userId: user.userId,
    username: user.username,
    groups: [...user.groups],
    roles: [...user.roles],
    delegated: options.delegated ?? false,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + ttl).toISOString(),
  };
}

/** Expiry is absolute: a session does not slide, it ends eight hours in (M8). */
export function isExpired(session: SessionRecord, now: Date): boolean {
  const expiresAt = Date.parse(session.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now.getTime();
}

/**
 * Reference session store. Constant-time lookup by token so a store scan
 * cannot be turned into a token oracle; the production store is Redis/Postgres
 * behind the same interface.
 */
export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  create(record: SessionRecord): Promise<void> {
    this.sessions.set(record.token, { ...record });
    return Promise.resolve();
  }

  get(token: string): Promise<SessionRecord | null> {
    for (const [stored, record] of this.sessions) {
      if (constantTimeEquals(stored, token)) return Promise.resolve({ ...record });
    }
    return Promise.resolve(null);
  }

  delete(token: string): Promise<void> {
    this.sessions.delete(token);
    return Promise.resolve();
  }

  /** Insertion order is issue order, so the oldest session is the first match. */
  listByUser(userId: string): Promise<readonly SessionRecord[]> {
    const owned = [...this.sessions.values()]
      .filter((record) => record.userId === userId)
      .map((record) => ({ ...record }));
    return Promise.resolve(owned);
  }

  deleteByUser(userId: string): Promise<number> {
    let removed = 0;
    for (const [token, record] of this.sessions) {
      if (record.userId === userId) {
        this.sessions.delete(token);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
  }

  /** Housekeeping for the reference implementation; the real store uses a TTL. */
  purgeExpired(now: Date): number {
    let removed = 0;
    for (const [token, record] of this.sessions) {
      if (isExpired(record, now)) {
        this.sessions.delete(token);
        removed += 1;
      }
    }
    return removed;
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** `Authorization: Bearer <token>` → token, or null. */
export function bearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") return null;
  const match = /^Bearer\s+(\S+)$/i.exec(value.trim());
  return match?.[1] ?? null;
}
