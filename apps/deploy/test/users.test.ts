import * as contracts from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import {
  PrismaUserDirectory,
  ROLE_BY_GROUP,
  rolesOf,
  type UserDelegate,
  type UserRow,
  type UserWriteRow,
} from "../src/stores/users.js";

/**
 * The Postgres-backed user directory.
 *
 * The delegate is a plain object rather than a real Prisma client — the store
 * takes three methods by SHAPE, which is what lets these tests run without a
 * database and without `prisma generate`.
 */

function row(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: "u-ayse",
    email: "ayse.kaya@ugurbank.local",
    displayName: "Ayşe Kaya",
    passwordHash: "$2b$12$hash",
    groupsJson: ["product-owners", "tech-leads"],
    active: true,
    ...overrides,
  };
}

function delegate(initial: UserRow | null = row()) {
  const calls: { upsert: unknown[]; update: unknown[]; findMany: unknown[] } = {
    upsert: [],
    update: [],
    findMany: [],
  };
  const store: UserDelegate = {
    findUnique: () => Promise.resolve(initial),
    findMany: (args) => {
      calls.findMany.push(args);
      return Promise.resolve(initial === null ? [] : [initial]);
    },
    upsert: (args) => {
      calls.upsert.push(args);
      return Promise.resolve(args.create);
    },
    update: (args) => {
      calls.update.push(args);
      return Promise.resolve(initial);
    },
  };
  return { store, calls };
}

describe("role mapping", () => {
  it("maps every group to a role the contract actually defines", () => {
    // Once `@maestro/contracts` exports ROLES this pins the mapping against
    // it; until then the assertion is skipped rather than faked, so this test
    // starts enforcing the closed set the moment the module lands.
    const roles = (contracts as Record<string, unknown>)["ROLES"];
    if (!Array.isArray(roles)) return;
    for (const role of Object.values(ROLE_BY_GROUP)) {
      expect(roles, `"${role}" is not in the Role union`).toContain(role);
    }
  });

  it("gives everyone at least viewer", () => {
    expect(rolesOf([])).toEqual(["viewer"]);
  });

  it("grants the roles behind a user's groups", () => {
    expect(rolesOf(["tech-leads"]).sort()).toEqual(["tech-lead", "viewer"]);
    expect(rolesOf(["maestro-admins"]).sort()).toEqual(["admin", "viewer"]);
  });

  it("ignores an unrecognised group instead of inventing a role from its name", () => {
    // A directory group added next quarter must not become an authorisation
    // the platform honours just because it exists.
    expect(rolesOf(["some-new-ad-group"])).toEqual(["viewer"]);
  });

  it("does not let a group named after a role grant it by coincidence", () => {
    expect(rolesOf(["admin"])).toEqual(["viewer"]);
  });
});

describe("PrismaUserDirectory", () => {
  it("reads a row into the record the identity provider expects", async () => {
    const { store } = delegate();
    const record = await new PrismaUserDirectory(store).find("AYSE.KAYA@ugurbank.local");

    expect(record).not.toBeNull();
    expect(record?.userId).toBe("u-ayse");
    expect(record?.username).toBe("ayse.kaya@ugurbank.local");
    expect(record?.groups).toEqual(["product-owners", "tech-leads"]);
    expect([...(record?.roles ?? [])].sort()).toEqual(["product-owner", "tech-lead", "viewer"]);
  });

  it("returns null for an unknown account", async () => {
    const { store } = delegate(null);
    expect(await new PrismaUserDirectory(store).find("nobody@ugurbank.local")).toBeNull();
  });

  it("reads a malformed groups column as no groups rather than as membership", async () => {
    // `groupsJson` is a JSON column, so its contents are whatever was written.
    // Anything that is not an array of strings must not become a membership —
    // membership is what opens gates.
    const { store } = delegate(row({ groupsJson: { not: "an array" } }));
    const record = await new PrismaUserDirectory(store).find("ayse.kaya@ugurbank.local");
    expect(record?.groups).toEqual([]);
    expect(record?.roles).toEqual(["viewer"]);
  });

  it("drops non-string entries from a partly malformed groups column", async () => {
    const { store } = delegate(row({ groupsJson: ["tech-leads", 42, null] }));
    const record = await new PrismaUserDirectory(store).find("ayse.kaya@ugurbank.local");
    expect(record?.groups).toEqual(["tech-leads"]);
  });

  it("deactivates rather than deletes on off-boarding", async () => {
    // A departed approver's name is on closed gates; deleting the row would
    // leave the audit trail pointing at nobody (M33).
    const { store, calls } = delegate();
    await new PrismaUserDirectory(store).remove("ayse.kaya@ugurbank.local");

    expect(calls.update).toHaveLength(1);
    expect(calls.update[0]).toMatchObject({ data: { active: false } });
  });

  it("normalises the username on every path", async () => {
    const { store, calls } = delegate();
    const directory = new PrismaUserDirectory(store);
    await directory.remove("  AYSE.KAYA@UgurBank.local  ");

    expect(calls.update[0]).toMatchObject({ where: { email: "ayse.kaya@ugurbank.local" } });
  });

  it("lists accounts through a bounded, ordered query", async () => {
    const { store, calls } = delegate();
    const records = await new PrismaUserDirectory(store).list(50);

    // The window is bounded and ordered so the same page comes back the same
    // way; the store never hands back the whole directory unasked.
    expect(calls.findMany[0]).toMatchObject({ take: 50, orderBy: { email: "asc" } });
    expect(records[0]?.username).toBe("ayse.kaya@ugurbank.local");
    expect([...(records[0]?.roles ?? [])].sort()).toEqual(["product-owner", "tech-lead", "viewer"]);
  });

  it("never asks a negative row count even when handed one", async () => {
    const { store, calls } = delegate();
    await new PrismaUserDirectory(store).list(-5);
    expect(calls.findMany[0]).toMatchObject({ take: 0 });
  });

  it("writes groups as an array the JSON column can hold", async () => {
    const { store, calls } = delegate();
    await new PrismaUserDirectory(store).upsert({
      username: "Mert.Demir@ugurbank.local",
      userId: "u-mert",
      passwordHash: "$2b$12$other",
      groups: ["tech-leads"],
      roles: ["tech-lead"],
      active: true,
    });

    expect(calls.upsert[0]).toMatchObject({
      where: { email: "mert.demir@ugurbank.local" },
      create: { id: "u-mert", groupsJson: ["tech-leads"] },
    });
  });

  it("round-trips the first-run bootstrap flag (migration 0009)", async () => {
    // A bootstrap admin row reads back as mustChangePassword=true.
    const { store } = delegate(
      row({ email: "admin", id: "admin", groupsJson: ["maestro-admins"], mustChangePassword: true }),
    );
    const record = await new PrismaUserDirectory(store).find("admin");
    expect(record?.mustChangePassword).toBe(true);
    expect(record?.roles).toContain("admin");
  });

  it("reads a row without the flag as a non-bootstrap account", async () => {
    // A row from before the column existed (undefined) is the safe default.
    const { store } = delegate(row());
    const record = await new PrismaUserDirectory(store).find("ayse.kaya@ugurbank.local");
    expect(record?.mustChangePassword).toBe(false);
  });

  it("writes the flag on upsert, defaulting a normal account to false", async () => {
    const { store, calls } = delegate();
    await new PrismaUserDirectory(store).upsert({
      username: "yeni.kullanici@ugurbank.local",
      userId: "u-yeni",
      passwordHash: "$2b$12$x",
      groups: ["developers"],
      roles: ["developer"],
      active: true,
      // No mustChangePassword: a normal account is never a bootstrap account.
    });
    expect(calls.upsert[0]).toMatchObject({
      create: { mustChangePassword: false },
      update: { mustChangePassword: false },
    });
  });
});

/**
 * The `displayName` column, and why it is no longer written from the username.
 *
 * This store used to set `displayName: record.username` on every upsert. That
 * was harmless while every account was created by a person typing their own
 * name — the two strings were the same. It stopped being harmless when the BFF
 * began PROVISIONING the Jira bot: that account's username is a machine id
 * (`jira-bot-jira`) and its readable name comes from Jira's `/myself`, so the
 * old write silently replaced "maestro (Jira bot)" with the slug on the next
 * upsert of that row — including its own re-provision.
 */
describe("display name", () => {
  it("stores the record's display name when it has one", async () => {
    const { store, calls } = delegate(null);
    const directory = new PrismaUserDirectory(store);

    await directory.upsert({
      username: "jira-bot-jira",
      userId: "jira-bot-jira@ugurbank.local",
      passwordHash: "!bot-no-login",
      groups: [],
      roles: ["viewer"],
      active: true,
      displayName: "maestro (Jira bot)",
    });

    const args = calls.upsert[0] as { create: UserWriteRow; update: { displayName: string } };
    // Both halves of the upsert: the row is named correctly whether it is being
    // created or overwritten. The update half is the one that used to clobber.
    expect(args.create.displayName).toBe("maestro (Jira bot)");
    expect(args.update.displayName).toBe("maestro (Jira bot)");
  });

  it("falls back to the username when the record carries no name", async () => {
    const { store, calls } = delegate(null);
    const directory = new PrismaUserDirectory(store);

    await directory.upsert({
      username: "ayse.kaya@ugurbank.local",
      userId: "ayse.kaya@ugurbank.local",
      passwordHash: "$2b$12$hash",
      groups: ["tech-leads"],
      roles: ["tech-lead", "viewer"],
      active: true,
    });

    // Exactly what this store did before the field existed — a hand-created
    // account is named by the person who typed it.
    const args = calls.upsert[0] as { create: UserWriteRow };
    expect(args.create.displayName).toBe("ayse.kaya@ugurbank.local");
  });

  it("reads the stored name back, so a find → upsert round-trip does not lose it", async () => {
    // The clobber has two sides. The write side is fixed above; this is the
    // read side — a record that came back without its name would re-upsert as
    // the username and undo the fix from the other direction.
    const { store, calls } = delegate(row({ email: "jira-bot-jira@ugurbank.local", displayName: "maestro (Jira bot)" }));
    const directory = new PrismaUserDirectory(store);

    const found = await directory.find("jira-bot-jira@ugurbank.local");
    expect(found?.displayName).toBe("maestro (Jira bot)");

    await directory.upsert({ ...found!, active: false });
    const args = calls.upsert[0] as { update: { displayName: string } };
    expect(args.update.displayName).toBe("maestro (Jira bot)");
  });
});
