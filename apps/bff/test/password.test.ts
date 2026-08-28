import { describe, expect, it } from "vitest";
import {
  assertPassword,
  BcryptPasswordHasher,
  checkPassword,
  DEFAULT_PASSWORD_POLICY,
  PasswordPolicyError,
} from "../src/auth/password.js";
import { InMemoryUserDirectory, LocalIdentityProvider } from "../src/auth/local-identity.js";

describe("password policy (M8)", () => {
  it("accepts a password that meets every rule", () => {
    expect(checkPassword("Maestro!Test-2026", "ayse.kaya")).toEqual([]);
  });

  it("names every rule the candidate breaks at once", () => {
    expect(checkPassword("kisa", "ayse.kaya").sort()).toEqual(
      ["no_digit", "no_symbol", "no_upper", "too_short"].sort(),
    );
  });

  it("rejects a password that is at most the login with decoration", () => {
    expect(checkPassword("Ayse.Kaya-2026!", "ayse.kaya")).toContain("contains_username");
  });

  it("matches the login case-insensitively and ignores the domain", () => {
    expect(checkPassword("XxAYSE.KAYAxx-1!", "Ayse.Kaya@ugurbank.local")).toContain(
      "contains_username",
    );
  });

  it("caps the length at bcrypt's 72 bytes, so the whole password is really checked", () => {
    const long = `Aa1!${"x".repeat(80)}`;
    expect(Buffer.byteLength(long, "utf8")).toBeGreaterThan(DEFAULT_PASSWORD_POLICY.maxBytes);
    expect(checkPassword(long, "ayse.kaya")).toContain("too_long");
  });

  it("counts bytes rather than characters for multi-byte passwords", () => {
    const turkish = `Aa1!${"ş".repeat(35)}`;
    expect(turkish.length).toBeLessThan(DEFAULT_PASSWORD_POLICY.maxBytes);
    expect(checkPassword(turkish, "ayse.kaya")).toContain("too_long");
  });

  it("throws a 400-shaped error listing the violations", () => {
    try {
      assertPassword("kisa", "ayse.kaya");
      expect.unreachable("assertPassword should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PasswordPolicyError);
      expect((error as PasswordPolicyError).status).toBe(400);
      expect((error as PasswordPolicyError).violations).toContain("too_short");
    }
  });
});

describe("bcrypt hasher", () => {
  it("round-trips a password and refuses the wrong one", async () => {
    const hasher = new BcryptPasswordHasher(4);
    const stored = await hasher.hash("Maestro!Test-2026");

    expect(stored).not.toContain("Maestro");
    expect(await hasher.verify("Maestro!Test-2026", stored)).toBe(true);
    expect(await hasher.verify("Maestro!Test-2027", stored)).toBe(false);
  });

  it("salts, so the same password hashes differently twice", async () => {
    const hasher = new BcryptPasswordHasher(4);
    expect(await hasher.hash("Maestro!Test-2026")).not.toBe(await hasher.hash("Maestro!Test-2026"));
  });

  it("burns a comparison when there is no account, without throwing", async () => {
    await expect(new BcryptPasswordHasher(4).burn()).resolves.toBeUndefined();
  });
});

describe("local identity provider", () => {
  it("enforces the policy when an account is provisioned, not at login", async () => {
    const provider = new LocalIdentityProvider(new InMemoryUserDirectory(), new BcryptPasswordHasher(4));

    await expect(
      provider.provision({
        username: "ayse.kaya",
        userId: "ayse.kaya@ugurbank.local",
        password: "kisa",
        groups: [],
        roles: [],
      }),
    ).rejects.toBeInstanceOf(PasswordPolicyError);
  });

  it("normalises the username on both sides", async () => {
    const users = new InMemoryUserDirectory();
    const provider = new LocalIdentityProvider(users, new BcryptPasswordHasher(4));
    await provider.provision({
      username: "  Ayse.Kaya  ",
      userId: "ayse.kaya@ugurbank.local",
      password: "Maestro!Test-2026",
      groups: ["tech-leads"],
      roles: [],
    });

    const user = await provider.authenticate("AYSE.KAYA", "Maestro!Test-2026");

    expect(user).toMatchObject({ userId: "ayse.kaya@ugurbank.local", groups: ["tech-leads"] });
  });

  it("never stores the plaintext password", async () => {
    const users = new InMemoryUserDirectory();
    const provider = new LocalIdentityProvider(users, new BcryptPasswordHasher(4));
    await provider.provision({
      username: "ayse.kaya",
      userId: "ayse.kaya@ugurbank.local",
      password: "Maestro!Test-2026",
      groups: [],
      roles: [],
    });

    const record = await users.find("ayse.kaya");
    expect(record?.passwordHash).not.toContain("Maestro");
    expect(record?.passwordHash.startsWith("$2")).toBe(true);
  });
});

/** `$2b$12$…` → 12. The cost is the work factor bcrypt actually performs. */
function costOf(hash: string): number {
  const cost = /^\$2[aby]?\$(\d{2})\$/.exec(hash)?.[1];
  if (cost === undefined) throw new Error(`not a bcrypt hash: ${hash}`);
  return Number(cost);
}

/**
 * The unknown-account path burns a hash so that "no such user" and "wrong
 * password" take the same time (M8/M32 — a departed approver is a live risk).
 * That only works if it burns the SAME work: a dummy pinned to a lower cost
 * than production does not close the oracle, it inverts it, and the response
 * time then says "this account exists" more loudly than doing nothing would.
 */
describe("BcryptPasswordHasher.burn (timing oracle)", () => {
  it.each([4, 6, 10, 12])("burns at the configured cost of %i", async (rounds) => {
    const hasher = new BcryptPasswordHasher(rounds);
    const real = await hasher.hash("Maestro!Test-2026");

    expect(costOf(real)).toBe(rounds);
    expect(costOf(hasher.equaliserHash)).toBe(rounds);
  });

  /**
   * The regression guard the finding asks for: changing `rounds` must not be
   * able to leave the dummy behind. A hard-coded constant passes the assertion
   * above for exactly one value of `rounds`; this one pins the relationship.
   */
  it("keeps the dummy in step when the cost is raised", async () => {
    const before = new BcryptPasswordHasher(4);
    const after = new BcryptPasswordHasher(12);

    expect(costOf(before.equaliserHash)).toBe(4);
    expect(costOf(after.equaliserHash)).toBe(12);
    expect(costOf(after.equaliserHash)).not.toBe(costOf(before.equaliserHash));
  });

  it("burns comparable work to a real verification", async () => {
    const hasher = new BcryptPasswordHasher(6);
    const stored = await hasher.hash("Maestro!Test-2026");

    const realStart = process.hrtime.bigint();
    await hasher.verify("Definitely-Not-It-1!", stored);
    const realMs = Number(process.hrtime.bigint() - realStart) / 1e6;

    const burnStart = process.hrtime.bigint();
    await hasher.burn();
    const burnMs = Number(process.hrtime.bigint() - burnStart) / 1e6;

    // Generous bounds: this asserts the same ORDER of work, not a stopwatch
    // match, so it does not turn into a flaky test on a loaded CI box.
    expect(burnMs).toBeGreaterThan(realMs / 4);
    expect(burnMs).toBeLessThan(realMs * 4);
  });

  it("compares against a real hash rather than short-circuiting", async () => {
    const hasher = new BcryptPasswordHasher(4);

    // A malformed dummy would make `compare` return early and burn nothing.
    expect(hasher.equaliserHash).toMatch(/^\$2[aby]?\$\d{2}\$[./A-Za-z0-9]{53}$/);
  });
});
