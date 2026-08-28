import type { PrismaClient } from "@prisma/client";
import { generateBootstrapPassword } from "./bootstrap-password.js";

/**
 * The first-run bootstrap admin (banking standard).
 *
 * A fresh, clean install has to be loggable-into by SOMEONE, or nobody can ever
 * reach the screen that creates the first real account. So the seed plants ONE
 * admin — username `admin` — and marks it `mustChangePassword`, which forces a
 * password change before that account can do anything else (the BFF guard
 * restricts the session to change-password/logout/session while the flag is
 * set, migration 0009).
 *
 * The password is GENERATED, not fixed. The seed used to plant the well-known
 * `admin123`, which meant every freshly installed site on the internet shared
 * one login until its operator reached the panel — a window whose length nobody
 * controlled. Now `seedFirstAdmin` draws a random, policy-conformant password
 * (`bootstrap-password.ts`), returns it in the result EXACTLY ONCE, and the
 * caller (apps/deploy/src/bin/migrate.ts) prints it to the migrate log — the
 * one place the installing operator is already looking. It is never stored in
 * clear anywhere, and the no-op path never returns it, so no later deploy can
 * fish it back out.
 *
 * A caller may still supply a fixed password (`options.password` — migrate
 * wires it to the `MAESTRO_BOOTSTRAP_PASSWORD` env var) for a dev stack or a
 * site whose runbook wants to choose the initial credential; the forced change
 * on first login applies either way, and the change-password endpoint runs the
 * FULL policy on the new password. The policy exemption of the seed path lives
 * HERE and nowhere else — `LocalIdentityProvider.provision` still enforces the
 * policy for every normal account.
 */

/** The bootstrap admin's fixed identity — one place, so the tests and the seed agree. */
export const FIRST_ADMIN_USERNAME = "admin";
export const FIRST_ADMIN_DISPLAY_NAME = "Yönetici";
/**
 * The row `id` — which becomes the AUDIT ACTOR for anything this account seals
 * (a connector "Test et", a gate approval). The audit chain (packages/audit)
 * requires a `local@domain` actor and rejects a bare `admin`, so the id must be
 * corporate-shaped even though the login `email` stays `admin` (login matches on
 * email — apps/deploy/src/stores/users.ts). Keeping id ≠ email is deliberate:
 * one is the durable identity, the other the human-typed login handle.
 */
export const FIRST_ADMIN_USER_ID = "admin@maestro.local";
/**
 * The directory group that maps to the `admin` role. Kept in step with
 * `ROLE_BY_GROUP` (apps/bff/src/auth/groups.ts, apps/deploy/src/stores/users.ts):
 * `maestro-admins` is the group whose reading grants `admin`. A group that does
 * not map to `admin` would leave the bootstrap account unable to reach the very
 * screens it exists to unlock.
 */
export const FIRST_ADMIN_GROUP = "maestro-admins";

/**
 * Hashes the bootstrap password. Injected rather than imported so `@maestro/db`
 * stays free of a hashing dependency — only the BFF's identity provider knows
 * bcrypt exists (see apps/bff/src/deps.ts). The composition root passes a
 * `BcryptPasswordHasher`; the offline test passes a fake.
 */
export type PasswordHashFn = (password: string) => Promise<string>;

export interface SeedFirstAdminOptions {
  /**
   * Use THIS password instead of generating one. For dev stacks and runbooks
   * that pre-agree the initial credential; the forced first-login change
   * applies regardless.
   */
  password?: string;
}

export type SeedFirstAdminResult =
  | {
      seeded: true;
      reason: "created";
      /**
       * The plaintext the account was planted with — surfaced HERE, once, so
       * the caller can print it to the log the operator is watching. Handle it
       * like the credential it is: log it or hand it over, never store it.
       */
      password: string;
    }
  | {
      /** The seed was a no-op; no credential was written and none is returned. */
      seeded: false;
      reason: "admin_exists";
    };

/** The two `PrismaClient.user` methods this seed touches, structurally. */
export interface SeedFirstAdminDb {
  user: {
    findFirst(args: {
      where: { groupsJson: { array_contains: string[] } };
      select: { id: true };
    }): Promise<{ id: string } | null>;
    create(args: {
      data: {
        id: string;
        email: string;
        displayName: string;
        passwordHash: string;
        groupsJson: string[];
        active: boolean;
        mustChangePassword: boolean;
      };
    }): Promise<unknown>;
  };
}

/**
 * Plant the first-run admin, ONCE, and never clobber a real one.
 *
 * The guard is "does an admin already exist" rather than "does the `admin`
 * username already exist": the moment ANY account maps to the `admin` role the
 * platform has a real administrator, and the bootstrap account has done its job.
 * Re-running the seed (every deploy runs it), or running it after the bootstrap
 * admin already changed their password (they are still an admin, so an admin
 * exists), is therefore a no-op — the credential is never reset, and a genuine
 * admin is never overwritten.
 *
 * `create`, not `upsert`: the existence check above already decided nothing
 * should be written, so an upsert here would only re-open the door to walking a
 * changed password back.
 */
export async function seedFirstAdmin(
  db: SeedFirstAdminDb,
  hash: PasswordHashFn,
  options?: SeedFirstAdminOptions,
): Promise<SeedFirstAdminResult> {
  // Any account whose groups include the admin group is a real administrator.
  // `groupsJson` is a JSON array column; `array_contains` asks Postgres whether
  // the group is in it, so the check is one indexed-enough query rather than a
  // table scan the seed then filters in memory.
  const existingAdmin = await db.user.findFirst({
    where: { groupsJson: { array_contains: [FIRST_ADMIN_GROUP] } },
    select: { id: true },
  });
  if (existingAdmin !== null) {
    return { seeded: false, reason: "admin_exists" };
  }

  // A supplied-but-blank password would plant an account whose password is ""
  // — worse than either alternative. Blank means "generate", like absent.
  const password = options?.password?.trim() || generateBootstrapPassword();

  await db.user.create({
    data: {
      id: FIRST_ADMIN_USER_ID,
      email: FIRST_ADMIN_USERNAME,
      displayName: FIRST_ADMIN_DISPLAY_NAME,
      passwordHash: await hash(password),
      groupsJson: [FIRST_ADMIN_GROUP],
      active: true,
      mustChangePassword: true,
    },
  });
  return { seeded: true, reason: "created", password };
}

/** Narrowing helper so the CLI and composition root can pass a full client. */
export function firstAdminDbOf(db: PrismaClient): SeedFirstAdminDb {
  return db as unknown as SeedFirstAdminDb;
}
