import { describe, expect, it } from "vitest";
import { createOutputMasker, jobSecrets, MIN_REDACTABLE_LENGTH, REDACTED } from "../src/masking.js";

/**
 * Log masking (task #6). The finding this closes: a password was recoverable
 * from an error message that reached the platform.
 */

describe("createOutputMasker — literal secrets", () => {
  it("redacts a secret wherever it appears in the text", () => {
    const token = "glpat-AbCdEf123456789012";
    const masker = createOutputMasker({ secrets: [token] });

    const out = masker.mask(`cloning with ${token} failed; retried with ${token}`);

    expect(out).not.toContain(token);
    expect(out.match(/\[REDACTED\]/g)).toHaveLength(2);
  });

  it("redacts the LONGEST secret first, leaving no tail behind", () => {
    // The short one is a substring of the long one — the classic partial-redaction bug.
    const long = "supersecretvalue-full-token";
    const short = "supersecretvalue";
    const masker = createOutputMasker({ secrets: [short, long] });

    const out = masker.mask(`token=${long}`);

    expect(out).toBe(`token=${REDACTED}`);
    expect(out).not.toContain("-full-token");
  });

  it("treats secrets as literals, not patterns", () => {
    // A regex metacharacter must not blow up or match wildly.
    const secret = "a.b*c(d)+password";
    const masker = createOutputMasker({ secrets: [secret] });

    expect(masker.mask(`x ${secret} y`)).toBe(`x ${REDACTED} y`);
    // The literal must not match some OTHER string the pattern would have.
    expect(masker.mask("aXbYYcd password")).toBe("aXbYYcd password");
  });

  it("ignores values too short to be credentials", () => {
    const masker = createOutputMasker({ secrets: ["ok"] });
    expect("ok".length).toBeLessThan(MIN_REDACTABLE_LENGTH);
    // Otherwise every "ok" in a build log becomes [REDACTED].
    expect(masker.mask("build ok")).toBe("build ok");
  });

  it("handles an empty secret list without redacting anything", () => {
    const masker = createOutputMasker({ secrets: [] });
    expect(masker.mask("plain output")).toBe("plain output");
  });
});

describe("createOutputMasker — PII layer", () => {
  it("masks institutional PII the job printed", () => {
    const masker = createOutputMasker({ secrets: [] });

    const out = masker.mask("customer email test.user@example.com in fixture");

    expect(out).not.toContain("test.user@example.com");
  });

  it("redacts a credential BEFORE the PII layer could tokenise it", () => {
    // A token that looks like an email would otherwise become a reversible
    // [EMAIL_1] — and the reverse map must never hold a credential.
    const secret = "service-account@corp.example.com";
    const masker = createOutputMasker({ secrets: [secret] });

    const out = masker.mask(`login as ${secret}`);

    expect(out).toBe(`login as ${REDACTED}`);
    expect(out).not.toMatch(/\[EMAIL_/);
  });
});

describe("jobSecrets", () => {
  it("covers the agent token and every job environment value", () => {
    const secrets = jobSecrets("agent-token-value-1234567", {
      GIT_PASSWORD: "hunter2-hunter2",
      HARMLESS: "value",
    });

    expect(secrets).toContain("agent-token-value-1234567");
    expect(secrets).toContain("hunter2-hunter2");
  });

  it("masks a secret that only exists in the job environment", () => {
    const password = "p@ssw0rd-from-vault-9911";
    const masker = createOutputMasker({
      secrets: jobSecrets("agent-token-value-1234567", { GIT_PASSWORD: password }),
    });

    const out = masker.mask(`fatal: Authentication failed using ${password}`);

    expect(out).not.toContain(password);
  });
});
