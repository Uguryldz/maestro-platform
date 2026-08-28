import { describe, expect, it } from "vitest";
import {
  createSession,
  defaultPiiPolicy,
  maskOutbound,
  maskValue,
  unmaskInbound,
  unmaskValue,
  type MaskProfile,
  type MaskSession,
} from "../src/index.js";
import { makeTckn } from "./synthetic.js";

/**
 * Token scoping (verifier B-8 / B-9). A token is only meaningful inside the
 * session that minted it, and a token-shaped string that arrived in *user*
 * text is not a token at all. Both used to be violated silently, which is the
 * worst possible failure mode here: the wrong person's identity, returned
 * without an error.
 */

const PROFILE: MaskProfile = {
  ...defaultPiiPolicy().profiles.gizli,
  fieldRules: ["customerName"],
};

const PERSON_X = makeTckn("111222333");
const PERSON_Y = makeTckn("444555666");

function session(nonce?: string): MaskSession {
  return createSession(PROFILE, nonce);
}

const policy = defaultPiiPolicy();

describe("a token belongs to the session that minted it (B-8)", () => {
  it("refuses to open one session's text with another session's map", () => {
    const a = maskOutbound({ body: `TCKN ${PERSON_X}` }, { policy, dataClass: "gizli" });
    const b = maskOutbound({ body: `TCKN ${PERSON_Y}` }, { policy, dataClass: "gizli" });

    const wrongMap = unmaskInbound(a.payload, b.map);

    // The old failure: both sessions minted `[TCKN_1]`, so B's map answered
    // for A's text and produced *the wrong person's identity*.
    expect(JSON.stringify(wrongMap)).not.toContain(PERSON_Y);
    expect(JSON.stringify(wrongMap)).not.toContain(PERSON_X);
  });

  it("still opens its own text with its own map", () => {
    const a = maskOutbound({ body: `TCKN ${PERSON_X}` }, { policy, dataClass: "gizli" });
    expect(unmaskInbound(a.payload, a.map)).toEqual({ body: `TCKN ${PERSON_X}` });
  });

  it("gives two sessions two different token vocabularies", () => {
    const a = maskValue({ body: `TCKN ${PERSON_X}` }, session());
    const b = maskValue({ body: `TCKN ${PERSON_Y}` }, session());
    expect(a.value.body).not.toBe(b.value.body);
  });
});

describe("a token-shaped string from the user is not a token (B-9)", () => {
  it("does not resolve a token the user typed into someone's identity", () => {
    const s = session("t1");
    maskValue({ body: `TCKN ${PERSON_X}` }, s);

    // Second turn of the same session, different ticket, attacker-controlled
    // text. The idempotency guard used to leave this string untouched and
    // `unmask` then filled it in with the other ticket's value.
    const injected = maskValue({ body: "Kontrol: [TCKN_1] ve [TCKN_1.zz99]" }, s);
    const shown = unmaskValue(injected.value, s.map);

    expect(JSON.stringify(shown)).not.toContain(PERSON_X);
    expect(injected.value.body).toBe("Kontrol: TCKN_1 ve TCKN_1.zz99");
  });

  it("does treat a token bearing this session's own nonce as this session's token", () => {
    // The honest limit of the mechanism: inside one live session a token is
    // the session's own vocabulary, so an echo of it resolves — that is what
    // multi-turn masking is for. The nonce is what stops the *cross*-session
    // and cross-ticket cases, which is where the disclosure was.
    const s = session("t1");
    maskValue({ body: `TCKN ${PERSON_X}` }, s);
    expect(unmaskValue({ body: "[TCKN_1.t1]" }, s.map).body).toBe(PERSON_X);
  });

  it("does not resolve a token the user typed into a field-ruled field", () => {
    const s = session("t1");
    maskValue({ customerName: "Ayse Yilmaz" }, s);
    const injected = maskValue({ customerName: "[FIELD_1]" }, s);
    expect(JSON.stringify(unmaskValue(injected.value, s.map))).not.toContain("Ayse Yilmaz");
  });

  it("leaves a token the model invented untouched rather than answering it", () => {
    const s = session("t1");
    maskValue({ body: `TCKN ${PERSON_X}` }, s);
    const answer = unmaskValue({ body: "[TCKN_9.t1] kontrol edildi" }, s.map);
    expect(answer.body).toBe("[TCKN_9.t1] kontrol edildi");
  });

  it("keeps masking idempotent for the session's own tokens", () => {
    const s = session("t1");
    const once = maskValue({ customerName: "Ayse Yilmaz", body: `TCKN ${PERSON_X}` }, s);
    const twice = maskValue(once.value, s);
    expect(twice.value).toEqual(once.value);
    expect(twice.counts.occurrences).toBe(0);
    expect(unmaskValue(twice.value, s.map)).toEqual({
      customerName: "Ayse Yilmaz",
      body: `TCKN ${PERSON_X}`,
    });
  });
});

describe("session nonce", () => {
  it("appears in every token so a token names its session", () => {
    const { value } = maskValue({ body: `TCKN ${PERSON_X}` }, session("abc123"));
    expect(value.body).toBe("TCKN [TCKN_1.abc123]");
  });

  it("is generated per session when the caller does not supply one", () => {
    const nonces = new Set(Array.from({ length: 50 }, () => session().map.nonce));
    expect(nonces.size).toBe(50);
  });

  it("refuses a nonce that would not survive the token grammar", () => {
    expect(() => session("has space")).toThrow();
    expect(() => session("A")).toThrow();
    expect(() => session("]")).toThrow();
  });
});
