import { describe, expect, it } from "vitest";
import {
  AuditChain,
  AuditFieldError,
  buildAnchor,
  GENESIS,
  HmacAnchorSigner,
  InMemoryAuditStore,
  rehash,
  sealEvent,
  SUBJECT_MAX_LENGTH,
  subjectRejection,
  verifyChain,
  type AuditEventCore,
} from "../src/index.js";
import { fixedClock } from "./helpers.js";

const CORE: AuditEventCore = {
  seq: 1,
  at: "2026-08-08T09:00:00.000Z",
  actor: "maestro-worker",
  action: "RUN_STARTED",
  subject: "UGURPAY-101",
  prevHash: GENESIS,
  meta: {},
};

const signer = new HmacAnchorSigner("anchor-key-2026", "unit-test-anchor-secret");

/**
 * K2. `NonEmpty` is `z.string().trim().min(1)` and Zod's `.trim()` is a
 * transform, so a seal that hashed its *input* and stored its *output* minted
 * records that failed their own verification. `subject` comes from outside the
 * platform — a Jira key, an app name, a runner id — so one trailing space was a
 * one-line denial of service against the trail.
 */
describe("subject is validated fail-closed before it is hashed (K2)", () => {
  it("refuses a subject with trailing or leading whitespace", () => {
    expect(() => sealEvent({ ...CORE, subject: "UGURPAY-1 " })).toThrow(AuditFieldError);
    expect(() => sealEvent({ ...CORE, subject: "UGURPAY-1 " })).toThrow(/leading or trailing whitespace/);
    expect(() => sealEvent({ ...CORE, subject: " UGURPAY-1" })).toThrow(AuditFieldError);
    expect(() => sealEvent({ ...CORE, subject: "UGURPAY-1\t" })).toThrow(AuditFieldError);
  });

  it("never seals a record that fails its own verification", () => {
    // The old behaviour: seal succeeded, then verifyChain said hash_mismatch and
    // buildAnchor refused to sign the day. Now nothing is written at all.
    const candidates = ["UGURPAY-1 ", " UGURPAY-1", "ugurweb\n"];
    for (const subject of candidates) {
      expect(() => sealEvent({ ...CORE, subject }), subject).toThrow(AuditFieldError);
    }

    const sealed = sealEvent({ ...CORE, subject: "UGURPAY-1" });
    expect(rehash(sealed)).toBe(sealed.hash);
    expect(verifyChain([sealed]).ok).toBe(true);
  });

  it("refuses the same value through the whole append path", async () => {
    const store = new InMemoryAuditStore();
    const chain = new AuditChain({ store, clock: fixedClock("2026-08-08T09:00:00.000Z") });

    await expect(
      chain.append({ actor: "maestro-worker", action: "RUN_STARTED", subject: "UGURPAY-1 " }),
    ).rejects.toThrow(AuditFieldError);
    expect(await store.head()).toBeNull();
  });

  it("would have poisoned a whole day's anchor — now the day still signs", async () => {
    const store = new InMemoryAuditStore();
    const chain = new AuditChain({ store, clock: fixedClock("2026-08-08T09:00:00.000Z") });

    await chain.append({ actor: "maestro-worker", action: "RUN_STARTED", subject: "UGURPAY-1" });
    await expect(
      chain.append({ actor: "maestro-worker", action: "CI_RESULT", subject: "UGURPAY-2 " }),
    ).rejects.toThrow(AuditFieldError);
    await chain.append({ actor: "maestro-worker", action: "RUN_CLOSED", subject: "UGURPAY-1" });

    const events = await store.read();
    const anchor = await buildAnchor({ events, signer, now: new Date("2026-08-08T23:59:59.000Z"), expectPrevHash: GENESIS });
    expect(anchor.eventCount).toBe(2);
  });
});

describe("subject length and normal form (D1, D7)", () => {
  it("refuses a subject longer than the column that stores it", () => {
    expect(SUBJECT_MAX_LENGTH).toBe(128);
    const long = "U".repeat(SUBJECT_MAX_LENGTH + 1);

    expect(subjectRejection(long)).toBe("too_long");
    expect(() => sealEvent({ ...CORE, subject: long })).toThrow(/at most 128 characters/);
    expect(() => sealEvent({ ...CORE, subject: "U".repeat(SUBJECT_MAX_LENGTH) })).not.toThrow();
  });

  it("refuses a subject that is not Unicode NFC", () => {
    const nfc = "ödeme-servisi";
    const nfd = nfc.normalize("NFD");

    expect(nfd).not.toBe(nfc);
    expect(subjectRejection(nfc)).toBeNull();
    expect(subjectRejection(nfd)).toBe("not_nfc");
    expect(() => sealEvent({ ...CORE, subject: nfd })).toThrow(/NFC/);
    // Two normal forms of one visible string would otherwise be two subjects
    // with two different hashes, splitting one ticket's trail in half.
    expect(sealEvent({ ...CORE, subject: nfc }).subject).toBe(nfc);
  });

  it("refuses control characters, which would split a CEF line in two", () => {
    expect(subjectRejection("UGUR\nPAY-1")).toBe("control_character");
    expect(subjectRejection("")).toBe("empty");
    expect(subjectRejection(42)).toBe("not_a_string");
    expect(subjectRejection("UGURPAY-1")).toBeNull();
  });
});

/**
 * O4. The contract accepts offsets, but `packages/db` stores `Timestamptz(3)`
 * and hands back `Z`: a record hashed over `…+03:00` no longer hashes to its own
 * fields once it has been through the database. `AuditChain` normalised already;
 * `sealEvent` is the seal every other producer uses, so it refuses too.
 */
describe("the sealed instant is the one the database returns (O4)", () => {
  it("refuses an offset-bearing instant", () => {
    expect(() => sealEvent({ ...CORE, at: "2026-08-08T12:00:00.000+03:00" })).toThrow(AuditFieldError);
    expect(() => sealEvent({ ...CORE, at: "2026-08-08T12:00:00.000+03:00" })).toThrow(/UTC ISO instant/);
  });

  it("refuses a UTC instant without millisecond precision", () => {
    expect(() => sealEvent({ ...CORE, at: "2026-08-08T09:00:00Z" })).toThrow(/UTC ISO instant/);
    expect(() => sealEvent({ ...CORE, at: "08.08.2026" })).toThrow(AuditFieldError);
  });

  it("accepts the form AuditChain writes, and it survives a Date round trip", () => {
    const event = sealEvent(CORE);
    expect(event.at).toBe(CORE.at);
    expect(new Date(event.at).toISOString()).toBe(event.at);
    expect(rehash(event)).toBe(event.hash);
  });
});
