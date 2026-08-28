import { generateBootstrapPassword } from "@maestro/db";

/**
 * Operator password reset (the node half of `deploy/<paket>/reset-admin.sh`).
 *
 * The story this replaces: a locked-out prod admin was recovered by hand —
 * bcrypt in a REPL, the hash pasted into `psql`. That works exactly once,
 * for the person who wrote the platform. This module is the same operation as
 * a supported, testable path: generate a fresh RANDOM password (the same
 * generator the first-run seed uses), bcrypt it with the SAME hasher the BFF
 * verifies with, write it to the account, force a password change on the next
 * login, and kill every live session of the account — a reset that leaves a
 * possibly-stolen token alive has not reset anything.
 *
 * Deliberately NOT here:
 * - No user creation. An unknown username is an error, not an upsert — a typo
 *   must not plant a second admin.
 * - No clearing of `mustChangePassword` to false. The old ad-hoc bin did that,
 *   which left the account sitting on a known password with no pressure to
 *   move off it. The temporary password is a corridor to the change screen.
 * - No printing. The BIN prints the password once; this module returns it.
 */

/** The `user` row slice the reset (and the bin's read-back verify) needs. */
export interface ResetUserRow {
  id: string;
  email: string;
  active: boolean;
  passwordHash: string;
}

/** Structural Prisma delegates, so the tests run against plain objects. */
export interface ResetUserDelegate {
  findUnique(args: { where: { email: string } }): Promise<ResetUserRow | null>;
  update(args: {
    where: { email: string };
    data: { passwordHash: string; active: boolean; mustChangePassword: boolean };
  }): Promise<unknown>;
}

export interface ResetSessionDelegate {
  deleteMany(args: { where: { userId: string } }): Promise<{ count: number }>;
}

export interface ResetDb {
  user: ResetUserDelegate;
  session: ResetSessionDelegate;
}

export type ResetAccountResult =
  | {
      ok: true;
      /** The login handle the reset actually applied to (normalized). */
      username: string;
      /**
       * The new plaintext — returned EXACTLY ONCE for the bin to print. Never
       * stored anywhere in clear.
       */
      password: string;
      /** Whether the account was inactive and has been re-activated. */
      reactivated: boolean;
      /** Live sessions destroyed alongside the old password. */
      killedSessions: number;
    }
  | { ok: false; reason: "not_found" };

/**
 * Reset one account's password to a fresh random one.
 *
 * The hash function is injected (the bin passes `BcryptPasswordHasher.hash`)
 * so this module, like the seed, never imports a hashing library; the password
 * generator is injectable so tests can pin the output.
 */
export async function resetAccountPassword(
  db: ResetDb,
  hash: (password: string) => Promise<string>,
  username: string,
  generate: () => string = generateBootstrapPassword,
): Promise<ResetAccountResult> {
  // The same normalization the login path applies (stores/users.ts): the
  // operator types the handle a human remembers, not the stored casing.
  const email = username.trim().toLowerCase();

  const row = await db.user.findUnique({ where: { email } });
  if (row === null) return { ok: false, reason: "not_found" };
  // Captured BEFORE the update: the row object may be live.
  const wasActive = row.active;

  const password = generate();
  await db.user.update({
    where: { email },
    data: {
      passwordHash: await hash(password),
      // A reset is also how a locked/off-boarded-by-mistake admin is revived;
      // an operator resetting a deliberately deactivated account is making an
      // explicit decision, announced by `reactivated` below.
      active: true,
      // The temporary password exists to be REPLACED: the account is forced
      // through the change-password screen before it can do anything else,
      // exactly like the first-run bootstrap (migration 0009).
      mustChangePassword: true,
    },
  });

  // The old credential is gone; every token minted under it must go too —
  // including whatever session prompted the "we're locked out / something is
  // wrong" call that led here.
  const { count } = await db.session.deleteMany({ where: { userId: row.id } });

  return {
    ok: true,
    username: email,
    password,
    reactivated: !wasActive,
    killedSessions: count,
  };
}
