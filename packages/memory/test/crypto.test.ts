import { describe, expect, it } from "vitest";
import * as memory from "../src/index.js";
import { SessionCryptoError } from "../src/errors.js";
import {
  openSessionBytes,
  sealSessionBytes,
  sealSessionBytesWith,
  SEALED_OVERHEAD_BYTES,
  SESSION_FORMAT_VERSION,
  SESSION_KEY_BYTES,
  type RandomSource,
} from "../src/crypto.js";

const KEY = new Uint8Array(SESSION_KEY_BYTES).fill(7);
const OTHER_KEY = new Uint8Array(SESSION_KEY_BYTES).fill(8);
const PLAIN = new TextEncoder().encode('{"messages":[{"role":"assistant"}]}');
/** The storage key the blob is bound to (M65 archive layout). */
const BOUND = "archive/2026/UGURPAY-1111/session-run-UGURPAY-1111.session.enc";
const OTHER_BOUND = "archive/2026/UGURPAY-2222/session-run-UGURPAY-2222.session.enc";

const fixedRandom = (fill: number): RandomSource => ({
  bytes: (count: number) => new Uint8Array(count).fill(fill),
});

const seal = (fill: number, bound = BOUND, plain = PLAIN): Uint8Array =>
  sealSessionBytesWith(fixedRandom(fill), KEY, plain, bound);

describe("session file sealing (M31)", () => {
  it("round-trips", () => {
    expect(openSessionBytes(KEY, seal(1), BOUND)).toEqual(PLAIN);
  });

  it("does not leave the plaintext readable", () => {
    const sealed = seal(1);
    expect(Buffer.from(sealed).toString("utf8")).not.toContain("assistant");
    expect(sealed.length).toBe(PLAIN.length + SEALED_OVERHEAD_BYTES);
  });

  it("produces a different blob for every IV", () => {
    const a = sealSessionBytes(KEY, PLAIN, BOUND);
    const b = sealSessionBytes(KEY, PLAIN, BOUND);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(openSessionBytes(KEY, a, BOUND)).toEqual(openSessionBytes(KEY, b, BOUND));
  });

  it("is reproducible when the randomness is injected", () => {
    expect(Buffer.from(seal(3)).equals(Buffer.from(seal(3)))).toBe(true);
  });

  it("refuses the wrong key", () => {
    expect(() => openSessionBytes(OTHER_KEY, seal(1), BOUND)).toThrow(SessionCryptoError);
  });

  it("refuses a blob presented under another archive key (Y-1)", () => {
    // The verifier's probe: copy UGURPAY-1111's sealed session onto
    // UGURPAY-2222's key. The bytes are intact and the content key is the
    // same, but the seal is bound to the key it was written under.
    const sealed = seal(1);
    expect(() => openSessionBytes(KEY, sealed, OTHER_BOUND)).toThrow(/authentication failed/);
    // …and the same run under a different year is a different key too.
    expect(() =>
      openSessionBytes(KEY, sealed, BOUND.replace("archive/2026", "archive/2027")),
    ).toThrow(/authentication failed/);
  });

  it("binds the key exactly, not by prefix", () => {
    const sealed = seal(1);
    expect(() => openSessionBytes(KEY, sealed, `${BOUND}x`)).toThrow(/authentication failed/);
  });

  it("refuses to seal or open without a binding key", () => {
    expect(() => sealSessionBytes(KEY, PLAIN, "")).toThrow(SessionCryptoError);
    expect(() => openSessionBytes(KEY, seal(1), "")).toThrow(SessionCryptoError);
  });

  it("refuses a tampered ciphertext instead of returning altered memory", () => {
    const edited = new Uint8Array(seal(1));
    const last = edited.length - 1;
    edited[last] = (edited[last] as number) ^ 0xff;
    expect(() => openSessionBytes(KEY, edited, BOUND)).toThrow(/authentication failed/);
  });

  it("refuses a tampered header", () => {
    const edited = new Uint8Array(seal(1));
    edited[0] = 0x00;
    expect(() => openSessionBytes(KEY, edited, BOUND)).toThrow(/not a maestro session blob/);
  });

  it("refuses an unknown format version", () => {
    const edited = new Uint8Array(seal(1));
    edited[4] = 9;
    expect(() => openSessionBytes(KEY, edited, BOUND)).toThrow(/unsupported format version/);
  });

  it("carries the bound format version (2 — v1 seals were not key-bound)", () => {
    expect(SESSION_FORMAT_VERSION).toBe(2);
    expect(seal(1)[4]).toBe(2);
    const v1 = new Uint8Array(seal(1));
    v1[4] = 1;
    expect(() => openSessionBytes(KEY, v1, BOUND)).toThrow(/unsupported format version 1/);
  });

  it("refuses a truncated blob", () => {
    expect(() => openSessionBytes(KEY, seal(1).slice(0, 8), BOUND)).toThrow(/truncated/);
  });

  it("refuses a key of the wrong size on both sides", () => {
    const short = new Uint8Array(16);
    expect(() => sealSessionBytes(short, PLAIN, BOUND)).toThrow(SessionCryptoError);
    expect(() => openSessionBytes(short, seal(1), BOUND)).toThrow(SessionCryptoError);
  });

  it("refuses a random source that returns the wrong length", () => {
    expect(() =>
      sealSessionBytesWith({ bytes: () => new Uint8Array(4) }, KEY, PLAIN, BOUND),
    ).toThrow(SessionCryptoError);
  });

  it("handles an empty session file", () => {
    expect(openSessionBytes(KEY, seal(2, BOUND, new Uint8Array(0)), BOUND)).toEqual(
      new Uint8Array(0),
    );
  });

  it("keeps the injectable randomness out of the public surface (O-10)", () => {
    // A caller that can inject the IV can repeat a GCM nonce, and two
    // ciphertexts under a repeated nonce XOR to the plaintexts. Production
    // wiring gets no such handle: only `crypto.ts` itself does.
    const names = Object.keys(memory);
    expect(names).not.toContain("nodeRandom");
    expect(names).not.toContain("sealSessionBytesWith");
  });
});
