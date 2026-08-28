import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_PASSWORD_LENGTH,
  FIRST_ADMIN_GROUP,
  FIRST_ADMIN_USERNAME,
  seedFirstAdmin,
  type SeedFirstAdminDb,
} from "../src/index.js";

/**
 * The offline half of the first-run bootstrap (banking standard). No database:
 * a fake `user` delegate that remembers what was created, so we can prove the
 * seed plants exactly ONE admin with a GENERATED password it surfaces exactly
 * once, never clobbers a real one, and never resets a changed password.
 */

interface Row {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  groupsJson: string[];
  active: boolean;
  mustChangePassword: boolean;
}

function fakeDb(seed: readonly Row[] = []): { db: SeedFirstAdminDb; rows: Row[] } {
  const rows: Row[] = seed.map((r) => ({ ...r, groupsJson: [...r.groupsJson] }));
  const db: SeedFirstAdminDb = {
    user: {
      findFirst: (args) => {
        const wanted = args.where.groupsJson.array_contains;
        const hit = rows.find((r) => wanted.every((g) => r.groupsJson.includes(g)));
        return Promise.resolve(hit ? { id: hit.id } : null);
      },
      create: (args) => {
        rows.push({ ...args.data, groupsJson: [...args.data.groupsJson] });
        return Promise.resolve(args.data);
      },
    },
  };
  return { db, rows };
}

/** A hasher whose output is inspectable, so the test never runs real bcrypt. */
const fakeHash = (password: string): Promise<string> => Promise.resolve(`hashed:${password}`);

describe("seedFirstAdmin (first-run bootstrap, M8)", () => {
  it("plants admin with a generated password and mustChangePassword on an empty database", async () => {
    const { db, rows } = fakeDb();

    const result = await seedFirstAdmin(db, fakeHash);

    expect(result.seeded).toBe(true);
    expect(result.reason).toBe("created");
    expect(rows).toHaveLength(1);
    const admin = rows[0]!;
    expect(admin.email).toBe(FIRST_ADMIN_USERNAME);
    expect(admin.email).toBe("admin");
    expect(admin.groupsJson).toContain(FIRST_ADMIN_GROUP);
    expect(admin.active).toBe(true);
    expect(admin.mustChangePassword).toBe(true);

    // The password is generated, surfaced in the result, and what was HASHED is
    // exactly what was surfaced — the operator's copy opens the account.
    if (!result.seeded) throw new Error("unreachable");
    expect(result.password).toHaveLength(BOOTSTRAP_PASSWORD_LENGTH);
    expect(admin.passwordHash).toBe(`hashed:${result.password}`);
    // And it is no longer the well-known bootstrap credential.
    expect(result.password).not.toBe("admin123");
  });

  it("generates a DIFFERENT password on every fresh install", async () => {
    const first = await seedFirstAdmin(fakeDb().db, fakeHash);
    const second = await seedFirstAdmin(fakeDb().db, fakeHash);
    if (!first.seeded || !second.seeded) throw new Error("both seeds must plant");
    expect(first.password).not.toBe(second.password);
  });

  it("uses the supplied password when the caller provides one (MAESTRO_BOOTSTRAP_PASSWORD)", async () => {
    const { db, rows } = fakeDb();

    const result = await seedFirstAdmin(db, fakeHash, { password: "Runbook-Chose-This-1!" });

    if (!result.seeded) throw new Error("must seed");
    expect(result.password).toBe("Runbook-Chose-This-1!");
    expect(rows[0]!.passwordHash).toBe("hashed:Runbook-Chose-This-1!");
    // Forced change applies to a chosen credential exactly as to a generated one.
    expect(rows[0]!.mustChangePassword).toBe(true);
  });

  it("treats a blank supplied password as absent — never plants an empty credential", async () => {
    const { db, rows } = fakeDb();

    const result = await seedFirstAdmin(db, fakeHash, { password: "   " });

    if (!result.seeded) throw new Error("must seed");
    expect(result.password.trim()).not.toBe("");
    expect(result.password).toHaveLength(BOOTSTRAP_PASSWORD_LENGTH);
    expect(rows[0]!.passwordHash).toBe(`hashed:${result.password}`);
  });

  it("is a no-op when an admin already exists — never a second admin, never a password out", async () => {
    const { db, rows } = fakeDb([
      {
        id: "ayse.kaya@ugurbank.local",
        email: "ayse.kaya",
        displayName: "Ayşe Kaya",
        passwordHash: "hashed:real-strong-password",
        groupsJson: [FIRST_ADMIN_GROUP],
        active: true,
        mustChangePassword: false,
      },
    ]);

    const result = await seedFirstAdmin(db, fakeHash);

    expect(result).toEqual({ seeded: false, reason: "admin_exists" });
    // The no-op result must not carry a credential the log would then print.
    expect("password" in result).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows.some((r) => r.email === "admin")).toBe(false);
  });

  it("does not reset the flag after the bootstrap admin has changed its password", async () => {
    // The bootstrap admin, AFTER a successful change-password: still an admin
    // (still in the admin group), flag cleared, password long since re-keyed.
    const changed: Row = {
      id: "admin",
      email: "admin",
      displayName: "Yönetici",
      passwordHash: "hashed:A-Real-Strong-Password-1!",
      groupsJson: [FIRST_ADMIN_GROUP],
      active: true,
      mustChangePassword: false,
    };
    const { db, rows } = fakeDb([changed]);

    const result = await seedFirstAdmin(db, fakeHash);

    expect(result.seeded).toBe(false);
    expect(rows).toHaveLength(1);
    // The seed left the changed credential and the cleared flag untouched.
    expect(rows[0]!.mustChangePassword).toBe(false);
    expect(rows[0]!.passwordHash).toBe("hashed:A-Real-Strong-Password-1!");
  });

  it("is idempotent: a second run after planting the bootstrap admin creates nothing", async () => {
    const { db, rows } = fakeDb();

    await seedFirstAdmin(db, fakeHash);
    const second = await seedFirstAdmin(db, fakeHash);

    expect(second.seeded).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mustChangePassword).toBe(true); // still the fresh bootstrap flag, not reset
  });
});
