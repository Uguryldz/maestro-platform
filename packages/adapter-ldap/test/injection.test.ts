import { describe, expect, it } from "vitest";
import { escapeDnValue, escapeFilterValue, renderUserFilter } from "../src/filter.js";
import { LdapConfigError } from "../src/errors.js";
import { LdapIdentityProvider } from "../src/identity.js";
import { FakeDirectory } from "./fake-directory.js";
import { parseFilter } from "./filter-engine.js";
import { config, directoryOptions, SERVICE_PASSWORD } from "./fixtures.js";

/**
 * LDAP injection.
 *
 * These assertions are only meaningful because the fake directory PARSES the
 * filter rather than pattern-matching it: an unescaped payload genuinely
 * changes which entries come back, so removing the escaping makes these tests
 * fail for the right reason. See the mutation evidence in RAPOR.md §7.
 */

const PAYLOADS = [
  "*",
  "*)(uid=*",
  "*)(objectClass=*",
  "alice)(|(sAMAccountName=*",
  "*))(|(objectClass=*",
  "\\2a",
  "alice\0extra",
  "(|(sAMAccountName=alice",
];

describe("escapeFilterValue", () => {
  it.each(PAYLOADS)("neutralises %j", (payload) => {
    const escaped = escapeFilterValue(payload);

    // No structural character survives unescaped.
    expect(escaped).not.toMatch(/(?<!\\[0-9a-f])[*()]/);
    expect(escaped.includes("\0")).toBe(false);
  });

  it("escapes the backslash so an escape cannot be forged", () => {
    // If `\` were left alone, the input `\2a` would arrive at the directory as
    // a literal wildcard escape — the payload writes its own escape sequence.
    expect(escapeFilterValue("\\2a")).toBe("\\5c2a");
  });

  it("leaves non-ASCII letters intact so Turkish names still authenticate", () => {
    expect(escapeFilterValue("Uğur Şeyma")).toBe("Uğur Şeyma");
  });

  it("escapes control characters that would otherwise reach a log on their own line", () => {
    expect(escapeFilterValue("alice\nadmin")).toBe("alice\\0aadmin");
  });
});

describe("renderUserFilter", () => {
  it("produces a filter that still parses to the intended shape", () => {
    const filter = renderUserFilter("(&(objectClass=user)(sAMAccountName={{username}}))", "*)(uid=*");

    // The payload became ONE assertion value rather than new filter structure.
    const node = parseFilter(filter);
    expect(node.kind).toBe("and");
    expect(node.kind === "and" && node.children).toHaveLength(2);
  });

  it("refuses a template with no placeholder", () => {
    expect(() => renderUserFilter("(objectClass=user)", "alice")).toThrow(LdapConfigError);
  });

  it("substitutes every occurrence", () => {
    const filter = renderUserFilter("(|(uid={{username}})(cn={{username}}))", "al*ce");
    expect(filter).toBe("(|(uid=al\\2ace)(cn=al\\2ace))");
  });
});

describe("injection against the fake directory", () => {
  function subjectFor() {
    const directory = new FakeDirectory(directoryOptions());
    const subject = new LdapIdentityProvider(config(), {
      connections: directory,
      servicePassword: () => Promise.resolve(SERVICE_PASSWORD),
    });
    return { directory, subject };
  }

  it.each(PAYLOADS)("payload %j authenticates nobody", async (payload) => {
    const { subject } = subjectFor();

    await expect(subject.authenticate(payload, "alice-Password!1")).resolves.toBeNull();
  });

  it("a wildcard username does not match every account", async () => {
    const { directory, subject } = subjectFor();

    await subject.authenticate("*", "alice-Password!1");

    // The search ran with the wildcard as DATA, so it matched no one...
    const search = directory.searches[0];
    expect(search?.filter).toContain("\\2a");
    // ...and no bind was ever attempted against a real user's DN.
    expect(directory.binds.some((b) => b.dn.toLowerCase().includes("cn=alice"))).toBe(false);
  });

  it("an unescaped payload WOULD have matched — proving the fake is not vacuous", async () => {
    const directory = new FakeDirectory(directoryOptions());
    const connection = await directory.connect();

    // Hand-built the way a vulnerable driver would build it: no escaping.
    const vulnerable = "(&(objectClass=user)(sAMAccountName=*)(!(userAccountControl:1.2.840.113556.1.4.803:=2)))";
    const matched = await connection.search({
      baseDn: "OU=Users,DC=bank,DC=local",
      filter: vulnerable,
      attributes: ["sAMAccountName"],
    });

    // Three enabled users match; the escaped form matches none. That gap is
    // exactly what the escaping closes.
    expect(matched.length).toBeGreaterThan(1);
  });
});

describe("escapeDnValue", () => {
  it("escapes DN-structural characters", () => {
    expect(escapeDnValue("Doe, John")).toBe("Doe\\, John");
    expect(escapeDnValue("a+b")).toBe("a\\+b");
  });

  it("escapes leading and trailing spaces and a leading hash", () => {
    expect(escapeDnValue(" lead")).toBe("\\ lead");
    expect(escapeDnValue("trail ")).toBe("trail\\ ");
    expect(escapeDnValue("#hash")).toBe("\\#hash");
  });
});
