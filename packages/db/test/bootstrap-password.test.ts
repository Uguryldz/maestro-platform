import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_PASSWORD_LENGTH,
  generateBootstrapPassword,
  type RandomIntFn,
} from "../src/index.js";

/**
 * The generated bootstrap/reset password. It is printed once, transcribed by a
 * human, and typed into a login form guarded by the M8 password policy — so
 * every property below is one of those three steps not failing.
 */
describe("generateBootstrapPassword", () => {
  it("is exactly the advertised length", () => {
    expect(generateBootstrapPassword()).toHaveLength(BOOTSTRAP_PASSWORD_LENGTH);
  });

  it("satisfies the platform's own password policy classes", () => {
    // The same four classes DEFAULT_PASSWORD_POLICY demands
    // (apps/bff/src/auth/password.ts). A generated credential the policy would
    // refuse teaches the operator the policy is decorative.
    for (let i = 0; i < 50; i += 1) {
      const password = generateBootstrapPassword();
      expect(password, "no upper").toMatch(/\p{Lu}/u);
      expect(password, "no lower").toMatch(/\p{Ll}/u);
      expect(password, "no digit").toMatch(/\p{Nd}/u);
      expect(password, "no symbol").toMatch(/[^\p{L}\p{Nd}]/u);
    }
  });

  it("never emits a character an operator can misread off a terminal", () => {
    // 0/O/o and 1/l/I are excluded: the password's whole life is one
    // transcription, and a transcription error here locks the operator out of
    // the account that was just created for them.
    for (let i = 0; i < 50; i += 1) {
      expect(generateBootstrapPassword()).not.toMatch(/[01OoIl]/);
    }
  });

  it("differs from call to call", () => {
    const seen = new Set(Array.from({ length: 20 }, () => generateBootstrapPassword()));
    expect(seen.size).toBe(20);
  });

  it("draws every character through the injected random source", () => {
    // Deterministic when the randomness is: proves nothing else (no clock, no
    // Math.random) feeds the credential.
    const sequenceOf = (): RandomIntFn => {
      let n = 0;
      return (maxExclusive: number) => {
        n += 7;
        return n % maxExclusive;
      };
    };
    expect(generateBootstrapPassword(sequenceOf())).toBe(generateBootstrapPassword(sequenceOf()));
  });
});
