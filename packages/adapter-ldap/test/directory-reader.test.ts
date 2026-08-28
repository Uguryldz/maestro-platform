import { describe, expect, it } from "vitest";
import { parseRoleMappings } from "../src/config.js";
import { directoryReaderConfigFrom, LdapDirectoryReader } from "../src/directory-reader.js";
import { LdapConfigError, LdapServiceAccountError, LdapUnavailableError } from "../src/errors.js";
import { FakeDirectory } from "./fake-directory.js";
import { config, directoryOptions, SERVICE_DN, SERVICE_PASSWORD } from "./fixtures.js";

function reader(
  directoryOverrides: Parameters<typeof directoryOptions>[0] = {},
  password: string = SERVICE_PASSWORD,
) {
  const directory = new FakeDirectory(directoryOptions(directoryOverrides));
  const subject = new LdapDirectoryReader(directoryReaderConfigFrom(config()), {
    connections: directory,
    bindDn: SERVICE_DN,
    servicePassword: () => Promise.resolve(password),
  });
  return { directory, subject };
}

describe("LdapDirectoryReader.membersOf", () => {
  it("resolves a group name to its members' addresses", async () => {
    const { subject } = reader();

    await expect(subject.membersOf("maestro-admins")).resolves.toEqual(["alice@bank.local"]);
  });

  it("follows nested groups, so escalation reaches the real approvers", async () => {
    const { subject } = reader();

    // carol is a direct member; bob is in payments-squad, nested inside.
    // carol has no `mail` attribute, so only bob's address comes back.
    await expect(subject.membersOf("maestro-developers")).resolves.toEqual(["bob@bank.local"]);
  });

  it("returns an empty list for a group that does not exist", async () => {
    const { subject } = reader();

    // A missing group is a config gap, not a reason to fail a workflow step.
    await expect(subject.membersOf("no-such-group")).resolves.toEqual([]);
  });

  it("escapes a group name so it cannot inject into the lookup filter", async () => {
    const { directory, subject } = reader();

    await subject.membersOf("*)(cn=*");

    const lookup = directory.searches[0];
    expect(lookup?.filter).toContain("\\2a");
    expect(lookup?.filter).not.toContain("*)(cn=*");
  });

  it("throws rather than silently notifying nobody when the directory is down", async () => {
    const { subject } = reader({ failWith: new Error("ECONNRESET") });

    await expect(subject.membersOf("maestro-admins")).rejects.toThrow(LdapUnavailableError);
  });

  it("refuses an empty service password instead of binding anonymously", async () => {
    const { subject } = reader({}, "");

    await expect(subject.membersOf("maestro-admins")).rejects.toThrow(LdapServiceAccountError);
  });

  it("never leaks the service password in the error", async () => {
    const secret = "another-s3cret";
    const { subject } = reader({}, secret);

    const error = await subject.membersOf("maestro-admins").catch((e: unknown) => e);
    expect(String(error)).not.toContain(secret);
  });

  it("deduplicates and sorts addresses so notifications are stable", async () => {
    const { subject } = reader();
    const first = await subject.membersOf("maestro-admins");
    const second = await subject.membersOf("maestro-admins");
    expect(first).toEqual(second);
  });
});

describe("parseRoleMappings", () => {
  it("parses the compact environment form", () => {
    expect(parseRoleMappings("maestro-admins:admin,maestro-qa:qa")).toEqual([
      { group: "maestro-admins", roles: ["admin"] },
      { group: "maestro-qa", roles: ["qa"] },
    ]);
  });

  it("parses multiple roles for one group", () => {
    expect(parseRoleMappings("maestro-leads:tech-lead|developer")).toEqual([
      { group: "maestro-leads", roles: ["tech-lead", "developer"] },
    ]);
  });

  it("returns an empty list for an unset or blank value", () => {
    expect(parseRoleMappings(undefined)).toEqual([]);
    expect(parseRoleMappings("   ")).toEqual([]);
  });

  it("parses the JSON array form, which is how DNs are expressed", () => {
    const json = '[{"group":"CN=maestro-admins,OU=Groups,DC=bank,DC=local","roles":["admin"]}]';
    expect(parseRoleMappings(json)).toEqual([
      { group: "CN=maestro-admins,OU=Groups,DC=bank,DC=local", roles: ["admin"] },
    ]);
  });

  it("refuses a bare DN in the compact form rather than splitting it into nonsense", () => {
    expect(() => parseRoleMappings("CN=admins,OU=Groups,DC=bank,DC=local:admin")).toThrow(
      LdapConfigError,
    );
  });

  it("refuses an entry that is not group:role", () => {
    expect(() => parseRoleMappings("maestro-admins")).toThrow(LdapConfigError);
  });

  it("refuses a role outside the closed union", () => {
    expect(() => parseRoleMappings("maestro-admins:superuser")).toThrow();
  });
});
