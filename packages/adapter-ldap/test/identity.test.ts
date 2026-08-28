import { describe, expect, it } from "vitest";
import { LdapServiceAccountError, LdapUnavailableError } from "../src/errors.js";
import { LdapIdentityProvider } from "../src/identity.js";
import { FakeDirectory } from "./fake-directory.js";
import {
  ALICE_DN,
  BOB_DN,
  config,
  directoryOptions,
  SERVICE_DN,
  SERVICE_PASSWORD,
} from "./fixtures.js";

/**
 * End-to-end against the fake directory: every path a real login takes, plus
 * every path an attacker would try.
 */

function provider(
  overrides: Record<string, unknown> = {},
  directoryOverrides: Parameters<typeof directoryOptions>[0] = {},
  password: string = SERVICE_PASSWORD,
) {
  const directory = new FakeDirectory(directoryOptions(directoryOverrides));
  const subject = new LdapIdentityProvider(config(overrides), {
    connections: directory,
    servicePassword: () => Promise.resolve(password),
  });
  return { directory, subject };
}

describe("successful login", () => {
  it("binds as the user and returns directory groups plus mapped roles", async () => {
    const { directory, subject } = provider();

    const user = await subject.authenticate("alice", "alice-Password!1");

    expect(user).not.toBeNull();
    expect(user?.username).toBe("alice");
    expect(user?.userId).toBe("alice@bank.local");
    // `internal-audit` is unknown to Maestro and is carried anyway.
    expect([...(user?.groups ?? [])].sort()).toEqual(["internal-audit", "maestro-admins"]);
    expect(user?.roles).toEqual(["admin", "viewer"]);

    // The user's own password was used to bind against the user's DN — the
    // whole point of "LDAP bind": we never verified a hash ourselves.
    expect(directory.binds).toContainEqual({ dn: ALICE_DN, password: "alice-Password!1" });
    // And the service account never saw the user's password.
    const serviceBinds = directory.binds.filter((b) => b.dn === SERVICE_DN);
    expect(serviceBinds.every((b) => b.password === SERVICE_PASSWORD)).toBe(true);
  });

  it("resolves roles through nested groups", async () => {
    const { subject } = provider();

    // bob is in payments-squad, which is nested inside maestro-developers.
    const user = await subject.authenticate("bob", "bob-Password!1");

    expect([...(user?.groups ?? [])].sort()).toEqual(["maestro-developers", "payments-squad"]);
    // qa from the DN-form mapping, developer from the nested group.
    expect(user?.roles).toEqual(["developer", "qa", "viewer"]);
  });

  it("falls back to <username>@domain when the directory has no UPN or mail", async () => {
    const { subject } = provider({ userIdFallbackDomain: "bank.local" });

    const user = await subject.authenticate("carol", "carol-Password!1");

    expect(user?.userId).toBe("carol@bank.local");
  });

  it("grants only the floor role when no mapping matches", async () => {
    const { subject } = provider({ roleMappings: [] });

    const user = await subject.authenticate("alice", "alice-Password!1");

    expect(user?.roles).toEqual(["viewer"]);
    // Groups are still reported in full — nothing is filtered away.
    expect([...(user?.groups ?? [])].sort()).toEqual(["internal-audit", "maestro-admins"]);
  });
});

describe("rejected logins are indistinguishable", () => {
  it("returns null for a wrong password", async () => {
    const { subject } = provider();
    await expect(subject.authenticate("alice", "wrong-password")).resolves.toBeNull();
  });

  it("returns null for an account that does not exist", async () => {
    const { subject } = provider();
    await expect(subject.authenticate("nobody", "any-Password!1")).resolves.toBeNull();
  });

  it("spends a bind on the unknown-account path too, so the two cannot be timed apart", async () => {
    const unknown = provider();
    await unknown.subject.authenticate("nobody", "any-Password!1");

    const wrong = provider();
    await wrong.subject.authenticate("alice", "wrong-password");

    // Same number of round trips either way: service bind + one user-DN bind.
    expect(unknown.directory.binds).toHaveLength(2);
    expect(wrong.directory.binds).toHaveLength(2);
  });
});

describe("empty and whitespace passwords", () => {
  /**
   * The fake directory returns SUCCESS for a zero-length bind, exactly as RFC
   * 4513 §5.1.2 requires of a real one. So these tests only pass because the
   * driver refuses before reaching it.
   */
  it("refuses an empty password without contacting the directory", async () => {
    const { directory, subject } = provider();

    await expect(subject.authenticate("alice", "")).resolves.toBeNull();

    expect(directory.connectCount).toBe(0);
    expect(directory.binds).toHaveLength(0);
  });

  it.each(["   ", "\t", "\n", " \t\n "])("refuses whitespace-only password %j", async (password) => {
    const { directory, subject } = provider();

    await expect(subject.authenticate("alice", password)).resolves.toBeNull();

    expect(directory.binds).toHaveLength(0);
  });

  it("proves the fake directory would have accepted the empty bind", async () => {
    const directory = new FakeDirectory(directoryOptions());
    const connection = await directory.connect();

    // This is the trap the driver sidesteps: an anonymous bind reads as success.
    await expect(connection.bindAs(ALICE_DN, "")).resolves.toBe(true);
  });

  it("refuses an empty username", async () => {
    const { directory, subject } = provider();

    await expect(subject.authenticate("   ", "alice-Password!1")).resolves.toBeNull();

    expect(directory.binds).toHaveLength(0);
  });
});

describe("deactivated accounts", () => {
  it("refuses a disabled account even with the correct password", async () => {
    const { directory, subject } = provider();

    await expect(subject.authenticate("dan", "dan-Password!1")).resolves.toBeNull();

    // Never bound as dan: the account state is checked before the password is proved.
    expect(directory.binds.some((b) => b.dn.toLowerCase().includes("cn=dan"))).toBe(false);
  });

  it("still refuses when the config filter omits the userAccountControl clause", async () => {
    // The second, independent check: a deployment that edits the filter must
    // not thereby re-open the "cancelled account stays admin" finding.
    const { subject } = provider({
      userFilter: "(&(objectClass=user)(sAMAccountName={{username}}))",
    });

    await expect(subject.authenticate("dan", "dan-Password!1")).resolves.toBeNull();
  });
});

describe("fail-closed", () => {
  it("throws rather than returning null when the directory is unreachable", async () => {
    const { subject } = provider({}, { failWith: new Error("ECONNREFUSED") });

    // null would read as "bad password" and hide an outage; it must throw.
    await expect(subject.authenticate("alice", "alice-Password!1")).rejects.toThrow(LdapUnavailableError);
  });

  it("throws when the service account cannot bind", async () => {
    const { subject } = provider({}, {}, "wrong-service-password");

    await expect(subject.authenticate("alice", "alice-Password!1")).rejects.toThrow(
      LdapServiceAccountError,
    );
  });

  it("refuses an empty service password instead of binding anonymously", async () => {
    const { directory, subject } = provider({}, {}, "");

    await expect(subject.authenticate("alice", "alice-Password!1")).rejects.toThrow(
      LdapServiceAccountError,
    );
    expect(directory.binds).toHaveLength(0);
  });

  it("never puts the service password in an error message", async () => {
    const secret = "sup3r-s3cret-service-pw";
    const { subject } = provider({}, {}, secret);

    const error = await subject.authenticate("alice", "alice-Password!1").catch((e: unknown) => e);
    const rendered = `${String(error)} ${JSON.stringify(error, Object.getOwnPropertyNames(error))}`;

    expect(rendered).not.toContain(secret);
    // It does name the DN and the reference, which is what an operator needs.
    expect(rendered).toContain("kv/ldap#service-password");
  });

  it("refuses when the filter matches more than one account", async () => {
    const { subject } = provider({
      // A filter an operator could plausibly write wrong: matches every user.
      userFilter: "(&(objectClass=user)(|(sAMAccountName={{username}})(objectClass=user)))",
    });

    await expect(subject.authenticate("alice", "alice-Password!1")).resolves.toBeNull();
  });
});

describe("group membership is read with the service identity", () => {
  it("re-binds as the service account before reading groups", async () => {
    const { directory, subject } = provider();

    await subject.authenticate("bob", "bob-Password!1");

    const userBindIndex = directory.binds.findIndex((b) => b.dn === BOB_DN);
    const laterServiceBind = directory.binds
      .slice(userBindIndex + 1)
      .find((b) => b.dn === SERVICE_DN);

    expect(userBindIndex).toBeGreaterThanOrEqual(0);
    expect(laterServiceBind).toBeDefined();
  });
});
