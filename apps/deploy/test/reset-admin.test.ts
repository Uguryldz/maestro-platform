import { describe, expect, it } from "vitest";
import { BcryptPasswordHasher, checkPassword, LocalIdentityProvider } from "@maestro/bff";
import type { UserDirectory, UserRecord } from "@maestro/bff";
import { resetAccountPassword, type ResetDb, type ResetUserRow } from "../src/reset-admin.js";
import { rolesOf } from "../src/stores/users.js";

/**
 * The operator reset (`reset-admin.sh` → bin/reset-admin-password.ts →
 * src/reset-admin.ts). The module is tested offline against fake delegates,
 * and once against the REAL bcrypt + the REAL login path — because the whole
 * incident this replaces was a hash written by hand that the login path then
 * refused.
 */

interface FakeRow extends ResetUserRow {
  mustChangePassword?: boolean;
}

function fakeDb(rows: FakeRow[], sessions: { token: string; userId: string }[] = []) {
  const updates: unknown[] = [];
  const db: ResetDb = {
    user: {
      findUnique: ({ where }) =>
        Promise.resolve(rows.find((row) => row.email === where.email) ?? null),
      update: ({ where, data }) => {
        const row = rows.find((candidate) => candidate.email === where.email);
        if (row === undefined) return Promise.reject(new Error("no row"));
        row.passwordHash = data.passwordHash;
        row.active = data.active;
        row.mustChangePassword = data.mustChangePassword;
        updates.push(data);
        return Promise.resolve(row);
      },
    },
    session: {
      deleteMany: ({ where }) => {
        const before = sessions.length;
        for (let i = sessions.length - 1; i >= 0; i -= 1) {
          if (sessions[i]!.userId === where.userId) sessions.splice(i, 1);
        }
        return Promise.resolve({ count: before - sessions.length });
      },
    },
  };
  return { db, rows, sessions, updates };
}

const fakeHash = (password: string): Promise<string> => Promise.resolve(`hashed:${password}`);

const admin = (): FakeRow => ({
  id: "admin@maestro.local",
  email: "admin",
  active: true,
  passwordHash: "hashed:forgotten-old-password",
  mustChangePassword: false,
});

describe("resetAccountPassword", () => {
  it("writes a fresh generated hash and forces a change on next login", async () => {
    const { db, rows } = fakeDb([admin()]);

    const result = await resetAccountPassword(db, fakeHash, "admin", () => "Fresh-Random-2!aa");

    if (!result.ok) throw new Error("reset must succeed");
    expect(result.password).toBe("Fresh-Random-2!aa");
    expect(rows[0]!.passwordHash).toBe("hashed:Fresh-Random-2!aa");
    // The temporary password is a corridor to the change screen, never a
    // resting state — the old bin cleared this flag, which is the bug.
    expect(rows[0]!.mustChangePassword).toBe(true);
  });

  it("generates a password the platform's own policy accepts", async () => {
    const { db } = fakeDb([admin()]);

    const result = await resetAccountPassword(db, fakeHash, "admin");

    if (!result.ok) throw new Error("reset must succeed");
    // The default generator (shared with the first-run seed) must clear the M8
    // policy the operator's NEXT password will be checked against — a corridor
    // the policy would reject teaches the operator the policy is decorative.
    expect(checkPassword(result.password, "admin")).toEqual([]);
  });

  it("kills every live session of the account, and only of that account", async () => {
    const { db, sessions } = fakeDb(
      [admin()],
      [
        { token: "t1", userId: "admin@maestro.local" },
        { token: "t2", userId: "admin@maestro.local" },
        { token: "t3", userId: "ayse.kaya@ugurbank.local" },
      ],
    );

    const result = await resetAccountPassword(db, fakeHash, "admin");

    if (!result.ok) throw new Error("reset must succeed");
    expect(result.killedSessions).toBe(2);
    expect(sessions.map((s) => s.token)).toEqual(["t3"]);
  });

  it("refuses an unknown username rather than creating anything", async () => {
    const { db, rows, updates } = fakeDb([admin()]);

    const result = await resetAccountPassword(db, fakeHash, "amdin"); // the typo case

    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(rows).toHaveLength(1);
    expect(updates).toHaveLength(0);
  });

  it("normalizes the username the same way login does", async () => {
    const { db, rows } = fakeDb([admin()]);

    const result = await resetAccountPassword(db, fakeHash, "  Admin ");

    if (!result.ok) throw new Error("reset must succeed");
    expect(result.username).toBe("admin");
    expect(rows[0]!.mustChangePassword).toBe(true);
  });

  it("re-activates a deactivated account and says so", async () => {
    const row = admin();
    row.active = false;
    const { db, rows } = fakeDb([row]);

    const result = await resetAccountPassword(db, fakeHash, "admin");

    if (!result.ok) throw new Error("reset must succeed");
    expect(result.reactivated).toBe(true);
    expect(rows[0]!.active).toBe(true);
  });

  it("reports reactivated=false for an account that was already active", async () => {
    const { db } = fakeDb([admin()]);
    const result = await resetAccountPassword(db, fakeHash, "admin");
    if (!result.ok) throw new Error("reset must succeed");
    expect(result.reactivated).toBe(false);
  });
});

describe("reset → login round trip (real bcrypt, real identity provider)", () => {
  it("logs in with the password the reset printed, restricted until changed", async () => {
    // Cost 4: the cheapest bcrypt that is still bcrypt — this test proves the
    // FORMAT round-trips, not the work factor.
    const hasher = new BcryptPasswordHasher(4);
    const { db, rows } = fakeDb([admin()]);

    const result = await resetAccountPassword(db, (password) => hasher.hash(password), "admin");
    if (!result.ok) throw new Error("reset must succeed");

    // The same directory shape the BFF's login path reads (stores/users.ts).
    const directory: UserDirectory = {
      find: (username) => {
        const row = rows.find((candidate) => candidate.email === username);
        if (row === undefined) return Promise.resolve(null);
        const record: UserRecord = {
          username: row.email,
          userId: row.id,
          passwordHash: row.passwordHash,
          groups: ["maestro-admins"],
          roles: rolesOf(["maestro-admins"]),
          active: row.active,
          mustChangePassword: row.mustChangePassword ?? false,
        };
        return Promise.resolve(record);
      },
    } as UserDirectory;

    const identity = new LocalIdentityProvider(directory, hasher);

    const user = await identity.authenticate("admin", result.password);
    expect(user, "the reset password must open the account").not.toBeNull();
    expect(user?.mustChangePassword).toBe(true);

    // And the OLD password is dead.
    expect(await identity.authenticate("admin", "forgotten-old-password")).toBeNull();
  });
});
