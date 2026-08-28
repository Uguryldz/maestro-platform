import { BcryptPasswordHasher } from "@maestro/bff";
import { createDb } from "@maestro/db";
import { PrismaUserDirectory } from "../src/stores/users.js";

/**
 * Create (or reset) one local admin account, for a smoke run against a real
 * database.
 *
 * It goes through `PrismaUserDirectory` and `BcryptPasswordHasher` rather than
 * writing the row directly: the point of a smoke run is to exercise the code
 * the deployment uses, and a hand-inserted row would prove the SQL works while
 * skipping the hash format the login path actually verifies against.
 *
 * `maestro-admins` is the group `ROLE_BY_GROUP` maps to `admin`; the roles are
 * derived from groups and are never written directly.
 */
async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  const username = process.env["ADMIN_USERNAME"];
  const password = process.env["ADMIN_PASSWORD"];
  if (url === undefined) throw new Error("DATABASE_URL: required");
  if (username === undefined) throw new Error("ADMIN_USERNAME: required");
  if (password === undefined) throw new Error("ADMIN_PASSWORD: required");

  const db = createDb(url);
  const users = new PrismaUserDirectory(db.user);
  const hasher = new BcryptPasswordHasher();

  await users.upsert({
    username,
    userId: username,
    passwordHash: await hasher.hash(password),
    groups: ["maestro-admins"],
    roles: [],
    active: true,
  });

  const stored = await users.find(username);
  console.info(`[create-admin] ${username} roles=${JSON.stringify(stored?.roles ?? [])}`);
  await db.$disconnect();
}

await main();
